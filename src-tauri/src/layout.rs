//! 커밋 그래프 레인 배치. git을 실행하지 않는 순수 계산이다.
//!
//! 입력은 topo 순서(자식이 먼저) 커밋 목록이고, 출력은 각 row의 레인/색과
//! "row i와 row i+1 사이 구간(band)"에 그릴 선분 목록이다. 프론트는 계산 없이 그린다.
//!
//! @see CONTRACTS.md

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, VecDeque};

use crate::model::Edge;
use crate::parse::RawCommit;

/// `LANE_COLORS`(src/constants.ts) 길이. color는 항상 0..COLOR_COUNT 범위다.
pub const COLOR_COUNT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowLayout {
    pub lane: usize,
    pub color: usize,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutResult {
    pub rows: Vec<RowLayout>,
    pub lane_count: usize,
}

/// 활성 레인 한 칸. `expected`는 이 레인이 기다리는 커밋 sha다.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Slot {
    expected: String,
    color: usize,
    /// 이 레인이 나르는 "자식 → 부모" 링크 ([`Links`] 인덱스)
    link: usize,
}

/// "자식 커밋 → 부모 커밋" 링크 표. 각 선분이 어느 링크에 속하는지 기록해
/// 프론트가 경로 강조를 판정할 수 있게 한다.
///
/// 자식 행은 링크를 만들 때 바로 알지만 부모 행은 그 커밋이 등장해야 정해진다.
/// 그래서 기다리는 부모 sha로 색인해 두었다가 해당 커밋을 처리할 때 한꺼번에 채운다.
/// 끝까지 안 채워진 링크(부모가 limit 밖)는 -1로 남는다.
#[derive(Debug, Default)]
struct Links {
    /// (자식 행, 부모 행). 부모 미확정이면 -1
    entries: Vec<(usize, i64)>,
    /// 기다리는 부모 sha → 아직 부모 행이 없는 링크들
    pending: HashMap<String, Vec<usize>>,
}

impl Links {
    fn create(&mut self, child_row: usize, parent_sha: &str) -> usize {
        let id = self.entries.len();
        self.entries.push((child_row, -1));
        self.pending
            .entry(parent_sha.to_string())
            .or_default()
            .push(id);
        id
    }

    /// `sha` 커밋이 `row`에 등장했다. 이 커밋을 기다리던 링크의 부모 행을 확정한다.
    fn resolve(&mut self, sha: &str, row: usize) {
        if let Some(ids) = self.pending.remove(sha) {
            for id in ids {
                self.entries[id].1 = row as i64;
            }
        }
    }

    fn rows_of(&self, link: usize) -> (usize, i64) {
        self.entries[link]
    }
}

/// 링크가 확정되기 전의 선분. 마지막에 [`Edge`]로 옮긴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RawEdge {
    from_lane: usize,
    to_lane: usize,
    color: usize,
    link: usize,
}

/// 레인 색 배정기. 아직 안 쓴 색을 먼저 내주고, 다 쓴 뒤에는 종료된 레인의 색을 재활용한다.
/// (SourceGit의 ColorPicker와 같은 방식)
#[derive(Debug)]
struct ColorPicker {
    available: VecDeque<usize>,
    wrap: usize,
}

impl ColorPicker {
    fn new() -> Self {
        Self {
            available: (0..COLOR_COUNT).collect(),
            wrap: 0,
        }
    }

    /// `blocked`(좌우 인접 레인의 색)와 겹치지 않는 후보를 우선 고른다.
    ///
    /// 후보 순서(미사용 색 먼저, 그다음 반납 FIFO)는 그대로 두고 충돌하는 것만 건너뛴다.
    /// 후보가 전부 겹치거나 색풀이 비면 기존 규칙으로 떨어진다.
    fn acquire_avoiding(&mut self, blocked: &[usize]) -> usize {
        if let Some(position) = self
            .available
            .iter()
            .position(|color| !blocked.contains(color))
        {
            if let Some(color) = self.available.remove(position) {
                return color;
            }
        }
        if let Some(color) = self.available.pop_front() {
            return color;
        }
        // 동시 활성 레인이 10개를 넘는 구간에서만 도달한다. 색이 겹치는 건 감수한다.
        let color = self.wrap % COLOR_COUNT;
        self.wrap += 1;
        color
    }

    fn release(&mut self, color: usize) {
        if !self.available.contains(&color) {
            self.available.push_back(color);
        }
    }
}

/// 활성 레인 배열.
///
/// 커밋마다 "이 sha를 기다리는 레인"과 "가장 왼쪽 빈 슬롯"을 찾는데, 배열을 매번 훑으면
/// 커밋당 O(레인 수)가 붙는다. 레인이 수십 개인 저장소에서 이게 지배적이라
/// sha 색인과 빈 슬롯 최소 힙을 함께 유지한다.
#[derive(Debug, Default)]
struct Lanes {
    slots: Vec<Option<Slot>>,
    /// 기다리는 sha → 그 sha를 기다리는 레인 인덱스들
    waiting: HashMap<String, Vec<usize>>,
    /// 비어 있는 레인 인덱스. 가장 왼쪽부터 재사용하려고 최소 힙을 쓴다
    free: BinaryHeap<Reverse<usize>>,
}

impl Lanes {
    fn len(&self) -> usize {
        self.slots.len()
    }

    fn slot(&self, index: usize) -> Option<&Slot> {
        self.slots.get(index).and_then(Option::as_ref)
    }

    fn active(&self) -> impl Iterator<Item = (usize, &Slot)> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| slot.as_ref().map(|slot| (index, slot)))
    }

    /// `sha`를 기다리는 레인들을 왼쪽부터. 보통 0~2개다.
    fn matches(&self, sha: &str) -> Vec<usize> {
        let mut found = self.waiting.get(sha).cloned().unwrap_or_default();
        found.sort_unstable();
        found
    }

    /// `sha`를 기다리는 가장 왼쪽 레인.
    fn find_waiting(&self, sha: &str) -> Option<usize> {
        self.waiting.get(sha)?.iter().copied().min()
    }

    /// 가장 왼쪽 빈 슬롯을 잡는다. 없으면 끝에 새로 만든다.
    fn alloc(&mut self) -> usize {
        // trim으로 사라졌거나 이미 채워진 인덱스는 버린다 (힙에 남는 낡은 항목)
        while let Some(Reverse(index)) = self.free.pop() {
            if self.slots.get(index).is_some_and(Option::is_none) {
                return index;
            }
        }
        self.slots.push(None);
        self.slots.len() - 1
    }

    fn set(&mut self, index: usize, expected: String, color: usize, link: usize) {
        self.detach(index);
        self.waiting
            .entry(expected.clone())
            .or_default()
            .push(index);
        self.slots[index] = Some(Slot {
            expected,
            color,
            link,
        });
    }

    /// 레인을 종료하고 쓰던 색을 돌려준다.
    fn clear(&mut self, index: usize) -> Option<usize> {
        let released = self.detach(index).map(|slot| slot.color);
        if index < self.slots.len() {
            self.free.push(Reverse(index));
        }
        released
    }

    /// 슬롯을 비우고 sha 색인에서도 뗀다.
    fn detach(&mut self, index: usize) -> Option<Slot> {
        let slot = self.slots.get_mut(index)?.take()?;
        if let Some(holders) = self.waiting.get_mut(&slot.expected) {
            holders.retain(|&lane| lane != index);
            if holders.is_empty() {
                self.waiting.remove(&slot.expected);
            }
        }
        Some(slot)
    }

    /// 바로 왼쪽과 오른쪽 레인의 색. 새 레인 색을 고를 때 피할 대상이다.
    ///
    /// 빈 슬롯은 왼쪽부터 곧바로 재사용되므로 사이가 비는 일이 드물다. 멀리까지 훑으면
    /// 커밋당 O(레인 수)가 되살아나서 바로 옆 두 칸만 본다.
    fn neighbor_colors(&self, index: usize) -> Vec<usize> {
        let mut colors = Vec::with_capacity(2);
        if let Some(left) = index.checked_sub(1).and_then(|left| self.slot(left)) {
            colors.push(left.color);
        }
        if let Some(right) = self.slot(index + 1) {
            colors.push(right.color);
        }
        colors
    }

    /// 끝쪽 빈 슬롯을 잘라 lane_count가 부풀지 않게 한다.
    fn trim(&mut self) {
        while matches!(self.slots.last(), Some(None)) {
            self.slots.pop();
        }
    }
}

/// 직전 row에서 생긴 병합 선분 정보. band (i-1, i)를 만들 때 쓴다.
/// 활성 레인 자체는 [`Lanes`]의 현재 상태가 곧 직전 row 처리 직후 상태라 따로 복제하지 않는다.
#[derive(Debug)]
struct Band {
    /// 병합 부모용으로 새로 만든 레인: (새 레인, 출발 레인)
    origins: Vec<(usize, usize)>,
    /// 이미 존재하는 레인으로 합류하는 병합 선분: (출발 레인, 도착 레인, 색, 링크)
    diagonals: Vec<(usize, usize, usize, usize)>,
}

/// topo 순서 커밋 목록에 레인/색/엣지를 배정한다.
pub fn assign_lanes(commits: &[RawCommit]) -> LayoutResult {
    let mut lanes = Lanes::default();
    let mut picker = ColorPicker::new();
    let mut links = Links::default();
    let mut rows: Vec<RowLayout> = Vec::with_capacity(commits.len());
    let mut bands: Vec<Vec<RawEdge>> = Vec::with_capacity(commits.len());
    let mut lane_count = 0usize;
    let mut band: Option<Band> = None;

    for (row_index, commit) in commits.iter().enumerate() {
        // 이 커밋을 기다리던 링크들의 부모 행이 여기서 정해진다
        links.resolve(&commit.sha, row_index);

        // 1. 이 커밋을 기다리는 레인들. 가장 왼쪽이 커밋 점의 레인이 된다.
        let matches = lanes.matches(&commit.sha);

        let (lane, color) = match matches.first() {
            Some(&first) => (first, lanes.slot(first).unwrap().color),
            // 기다리는 레인이 없으면 새 브랜치 tip이다.
            // alloc은 빈 슬롯만 건드리므로 아래 band 계산(활성 레인만 훑는다)에 영향이 없다.
            None => {
                let index = lanes.alloc();
                let color = picker.acquire_avoiding(&lanes.neighbor_colors(index));
                (index, color)
            }
        };

        // 직전 row의 band는 이번 커밋의 레인을 알아야 확정된다.
        // 이 시점의 lanes 상태가 곧 직전 row를 처리한 직후 상태다.
        if let Some(previous) = band.take() {
            if let Some(slot) = bands.last_mut() {
                *slot = build_edges(&lanes, &previous, &commit.sha, lane);
            }
        }

        // 2. 나머지 match는 이 커밋에서 끝난다. 색은 색풀로 돌려준다.
        for &index in matches.iter().skip(1) {
            if let Some(released) = lanes.clear(index) {
                picker.release(released);
            }
        }

        // 3. 커밋 레인은 first parent를 기다린다. 루트면 레인이 끝난다.
        match commit.parents.first() {
            Some(first_parent) => {
                let link = links.create(row_index, first_parent);
                lanes.set(lane, first_parent.clone(), color, link);
            }
            None => {
                lanes.clear(lane);
                picker.release(color);
            }
        }

        // 4. 추가 부모(merge). 이미 기다리는 레인이 있으면 연결만, 없으면 새 레인을 만든다.
        let mut origins = Vec::new();
        let mut diagonals = Vec::new();
        for (position, parent) in commit.parents.iter().enumerate().skip(1) {
            // 같은 부모가 두 번 적힌 커밋은 링크도 하나다
            if commit.parents[..position].contains(parent) {
                continue;
            }
            let link = links.create(row_index, parent);
            match lanes.find_waiting(parent) {
                Some(index) => {
                    let existing_color = lanes.slot(index).unwrap().color;
                    diagonals.push((lane, index, existing_color, link));
                }
                None => {
                    let index = lanes.alloc();
                    let new_color = picker.acquire_avoiding(&lanes.neighbor_colors(index));
                    lanes.set(index, parent.clone(), new_color, link);
                    origins.push((index, lane));
                }
            }
        }

        lanes.trim();
        lane_count = lane_count.max(lanes.len()).max(lane + 1);

        rows.push(RowLayout {
            lane,
            color,
            edges: Vec::new(),
        });
        bands.push(Vec::new());
        band = Some(Band { origins, diagonals });
    }

    // 마지막 row 아래 구간: 살아있는 레인은 화면 밖으로 계속 내려간다.
    if let Some(previous) = band.take() {
        if let Some(slot) = bands.last_mut() {
            *slot = build_edges(&lanes, &previous, "", 0);
        }
    }

    // 이제 모든 링크의 부모 행이 정해졌다(끝까지 미해결이면 -1). 선분에 옮겨 담는다.
    for (row, raw_edges) in rows.iter_mut().zip(bands) {
        row.edges = raw_edges
            .into_iter()
            .map(|raw| {
                let (child_row, parent_row) = links.rows_of(raw.link);
                Edge {
                    from_lane: raw.from_lane,
                    to_lane: raw.to_lane,
                    color: raw.color,
                    child_row,
                    parent_row,
                }
            })
            .collect();
    }

    LayoutResult {
        rows,
        lane_count: lane_count.max(1),
    }
}

/// band 하나의 선분을 만든다.
///
/// - 새로 생긴 병합 레인은 출발점이 병합 커밋의 레인이다 (점에서 벌어지는 선)
/// - `next_sha`를 기다리는 레인은 도착점이 다음 커밋의 레인이다 (점으로 합류하는 선)
/// - 그 밖에는 수직 통과선이다
///
/// 모든 선분은 자기가 속한 링크를 함께 들고 나간다. 통과선은 그 레인이 나르는 링크,
/// 병합 선분은 그 병합이 만든 링크다.
///
/// `next_sha`가 빈 문자열이면 다음 row가 없는 마지막 band다.
fn build_edges(lanes: &Lanes, band: &Band, next_sha: &str, next_lane: usize) -> Vec<RawEdge> {
    let mut edges: Vec<RawEdge> = Vec::with_capacity(lanes.len() + band.diagonals.len());

    for &(from, target, color, link) in &band.diagonals {
        let to = if ends_at_next(lanes, target, next_sha) {
            next_lane
        } else {
            target
        };
        let edge = RawEdge {
            from_lane: from,
            to_lane: to,
            color,
            link,
        };
        if !edges.contains(&edge) {
            edges.push(edge);
        }
    }

    // 레인끼리는 출발 레인이 서로 달라 중복이 나올 수 없다. 병합 선분과만 겹칠 수 있어
    // 그 구간(보통 비어 있다)만 대조한다. 레인 수 제곱 비교를 피하려는 것이다.
    let diagonal_count = edges.len();
    for (index, slot) in lanes.active() {
        let from = band
            .origins
            .iter()
            .find(|(lane, _)| *lane == index)
            .map(|(_, origin)| *origin)
            .unwrap_or(index);
        let to = if ends_at_next(lanes, index, next_sha) {
            next_lane
        } else {
            index
        };
        let edge = RawEdge {
            from_lane: from,
            to_lane: to,
            color: slot.color,
            link: slot.link,
        };
        if !edges[..diagonal_count].contains(&edge) {
            edges.push(edge);
        }
    }

    edges
}

fn ends_at_next(lanes: &Lanes, lane: usize, next_sha: &str) -> bool {
    if next_sha.is_empty() {
        return false;
    }
    lanes
        .slot(lane)
        .is_some_and(|slot| slot.expected == next_sha)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str, parents: &[&str]) -> RawCommit {
        RawCommit {
            sha: sha.to_string(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: "T".to_string(),
            author_email: "t@t.com".to_string(),
            timestamp: 0,
            subject: sha.to_string(),
        }
    }

    /// (출발 레인, 도착 레인, 색, 링크의 자식 행, 링크의 부모 행)
    fn edge(
        from_lane: usize,
        to_lane: usize,
        color: usize,
        child_row: usize,
        parent_row: i64,
    ) -> Edge {
        Edge {
            from_lane,
            to_lane,
            color,
            child_row,
            parent_row,
        }
    }

    #[test]
    fn 선형_히스토리는_레인_0에_수직선만_그린다() {
        // A -> B -> C (C가 루트)
        let commits = [commit("A", &["B"]), commit("B", &["C"]), commit("C", &[])];
        let result = assign_lanes(&commits);

        assert_eq!(result.lane_count, 1);
        assert!(result.rows.iter().all(|r| r.lane == 0 && r.color == 0));

        // band 0, 1은 통과 수직선, 마지막 band는 루트라 비어 있다.
        // 통과선도 자기 링크(자식 행 → 부모 행)를 들고 있다
        assert_eq!(result.rows[0].edges, vec![edge(0, 0, 0, 0, 1)]);
        assert_eq!(result.rows[1].edges, vec![edge(0, 0, 0, 1, 2)]);
        assert!(result.rows[2].edges.is_empty(), "루트 아래로는 선이 없다");
    }

    #[test]
    fn 커밋이_없으면_레인_수는_1이다() {
        let result = assign_lanes(&[]);
        assert!(result.rows.is_empty());
        assert_eq!(result.lane_count, 1);
    }

    #[test]
    fn 분기와_머지에서_벌어지는_선과_합류하는_선을_모두_내려준다() {
        // M(merge) -> [Ma, F], Ma -> B, F -> B, B -> A, A는 루트
        let commits = [
            commit("M", &["Ma", "F"]),
            commit("Ma", &["B"]),
            commit("F", &["B"]),
            commit("B", &["A"]),
            commit("A", &[]),
        ];
        let result = assign_lanes(&commits);

        assert_eq!(result.lane_count, 2);
        let lanes: Vec<usize> = result.rows.iter().map(|r| r.lane).collect();
        assert_eq!(lanes, vec![0, 0, 1, 0, 0]);
        let colors: Vec<usize> = result.rows.iter().map(|r| r.color).collect();
        assert_eq!(colors, vec![0, 0, 1, 0, 0]);

        // band(M, Ma): first parent 수직선 + 병합 부모 F로 벌어지는 선
        // fan-out 선분은 머지 커밋(row 0)에서 두 번째 부모 F(row 2)로 가는 링크다
        assert_eq!(
            result.rows[0].edges,
            vec![edge(0, 0, 0, 0, 1), edge(0, 1, 1, 0, 2)],
            "머지 커밋 점에서 새 레인 1로 벌어지는 선이 있어야 한다"
        );

        // band(Ma, F): 레인 0은 B를 기다리며 통과(Ma→B 링크), 레인 1은 M→F 링크를 계속 나른다
        assert_eq!(
            result.rows[1].edges,
            vec![edge(0, 0, 0, 1, 3), edge(1, 1, 1, 0, 2)]
        );

        // band(F, B): 두 레인이 모두 B를 기다린다. 레인 1은 커밋 레인 0으로 합류한다
        // 합류선은 F(row 2) → B(row 3) 링크다
        assert_eq!(
            result.rows[2].edges,
            vec![edge(0, 0, 0, 1, 3), edge(1, 0, 1, 2, 3)],
            "레인 1이 row B의 커밋 점으로 합류하는 선이 band(F, B)에 있어야 한다"
        );

        // band(B, A): 레인 1은 종료됐고 레인 0만 남는다
        assert_eq!(result.rows[3].edges, vec![edge(0, 0, 0, 3, 4)]);
        assert!(result.rows[4].edges.is_empty());
    }

    #[test]
    fn 두_브랜치가_교차해도_각자_레인과_색을_유지한다() {
        // A -> C, B -> D, C -> E, D -> E, E는 루트 (A/B 두 tip이 나란히 내려온다)
        let commits = [
            commit("A", &["C"]),
            commit("B", &["D"]),
            commit("C", &["E"]),
            commit("D", &["E"]),
            commit("E", &[]),
        ];
        let result = assign_lanes(&commits);

        assert_eq!(result.lane_count, 2);
        assert_eq!(
            result.rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
            vec![0, 1, 0, 1, 0]
        );
        assert_eq!(
            result.rows.iter().map(|r| r.color).collect::<Vec<_>>(),
            vec![0, 1, 0, 1, 0]
        );

        // 새 tip B는 band(A, B)에 선이 없다. 레인 0만 통과한다 (A→C 링크)
        assert_eq!(result.rows[0].edges, vec![edge(0, 0, 0, 0, 2)]);
        // band(B, C): 레인 0이 C에서 끝나고, 레인 1은 D를 기다리며 통과(B→D 링크)
        assert_eq!(
            result.rows[1].edges,
            vec![edge(0, 0, 0, 0, 2), edge(1, 1, 1, 1, 3)]
        );
        // band(C, D): 레인 0은 C→E 링크로 통과, 레인 1이 D에서 끝난다
        assert_eq!(
            result.rows[2].edges,
            vec![edge(0, 0, 0, 2, 4), edge(1, 1, 1, 1, 3)]
        );
        // band(D, E): 두 레인이 E를 기다린다 → 레인 1은 레인 0으로 합류(D→E 링크)
        assert_eq!(
            result.rows[3].edges,
            vec![edge(0, 0, 0, 2, 4), edge(1, 0, 1, 3, 4)]
        );
        assert!(result.rows[4].edges.is_empty());
    }

    #[test]
    fn 이미_존재하는_레인으로_합류하는_머지는_추가_선분만_만든다() {
        // M2가 이미 레인이 잡혀 있는 F를 두 번째 부모로 가진다
        // M1 -> [X, F], X -> Y, M2 -> ... 형태를 단순화:
        //   T   -> [T1]          레인 0
        //   M   -> [T1, F]  ← F 레인을 새로 만든다
        // 대신 F 레인이 먼저 생긴 뒤 다른 커밋이 같은 F를 부모로 갖는 경우를 만든다
        let commits = [
            commit("H1", &["F"]),      // 레인 0이 F를 기다린다
            commit("H2", &["P", "F"]), // 레인 1 tip, 두 번째 부모 F는 이미 레인 0이 기다림
            commit("P", &["F"]),
            commit("F", &[]),
        ];
        let result = assign_lanes(&commits);

        assert_eq!(result.rows[0].lane, 0);
        assert_eq!(result.rows[1].lane, 1);
        assert_eq!(result.rows[1].color, 1);

        // band(H2, P): 레인 0(F 대기) 통과 + 레인 1은 P에서 끝남 + 레인 1 → 레인 0 병합 선분
        let band = &result.rows[1].edges;
        // 병합 선분은 H2(row 1) → F(row 3) 링크,
        // 통과선은 H1(row 0) → F(row 3) 링크로 서로 다른 링크다
        assert!(
            band.contains(&edge(1, 0, 0, 1, 3)),
            "이미 있는 레인 0으로 합류하는 선분이 있어야 한다: {band:?}"
        );
        assert!(
            band.contains(&edge(0, 0, 0, 0, 3)),
            "레인 0의 통과선도 남아야 한다: {band:?}"
        );
        assert_eq!(result.lane_count, 2);
    }

    #[test]
    fn 종료된_레인의_색을_새_레인에_재활용한다() {
        // 레인을 11개까지 벌려 초기 색 10개를 소진시킨 뒤,
        // 레인이 종료되고 나서 새로 생기는 레인이 반납된 색을 받는지 본다
        let mut commits = Vec::new();
        for i in 0..11 {
            commits.push(commit(&format!("T{i}"), &[&format!("P{i}")]));
        }
        for i in 0..11 {
            commits.push(commit(&format!("P{i}"), &[]));
        }
        // 모든 레인이 닫힌 뒤 새 tip 하나
        commits.push(commit("Z", &[]));

        let result = assign_lanes(&commits);

        let tip_colors: Vec<usize> = result.rows[..11].iter().map(|r| r.color).collect();
        assert_eq!(
            tip_colors,
            vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0],
            "초기 10색을 순서대로 쓰고 11번째는 순환한다"
        );
        assert_eq!(result.lane_count, 11);

        // P0..P10은 각 레인의 마지막 커밋이라 색을 반납한다.
        // Z는 가장 먼저 반납된 색(0)을 다시 받는다.
        let last = result.rows.last().unwrap();
        assert_eq!(last.lane, 0);
        assert_eq!(last.color, 0, "종료된 레인의 색이 재활용된다");
    }

    #[test]
    fn 새_레인_색은_좌우_인접_레인_색을_피한다() {
        // 레인 0, 1, 2가 동시에 살아 있는 구간을 만든다
        let commits = [
            commit("A", &["A1"]),
            commit("B", &["B1"]),
            commit("C", &["C1"]),
            commit("A1", &[]),
            commit("B1", &[]),
            commit("C1", &[]),
        ];
        let result = assign_lanes(&commits);
        assert_eq!(result.lane_count, 3);

        let colors: Vec<usize> = result.rows[..3].iter().map(|r| r.color).collect();
        assert_eq!(colors, vec![0, 1, 2]);

        // 이웃한 레인끼리 색이 겹치지 않는다
        assert_ne!(colors[0], colors[1]);
        assert_ne!(colors[1], colors[2]);
    }

    #[test]
    fn 반납된_색이_인접_레인과_겹치면_다음_후보를_쓴다() {
        let mut picker = ColorPicker::new();
        // 색풀을 반납분만 남게 만든다
        let taken: Vec<usize> = (0..COLOR_COUNT)
            .map(|_| picker.acquire_avoiding(&[]))
            .collect();
        assert_eq!(taken, (0..COLOR_COUNT).collect::<Vec<_>>());

        picker.release(3);
        picker.release(6);

        // 앞 후보(3)가 인접색이면 건너뛰고 6을 쓴다
        assert_eq!(picker.acquire_avoiding(&[3]), 6);
        // 남은 후보는 3뿐이라 인접해도 그대로 쓴다
        assert_eq!(picker.acquire_avoiding(&[3]), 3);
    }

    #[test]
    fn 후보가_전부_인접색이면_기존_순서를_따른다() {
        let mut picker = ColorPicker::new();
        // 후보 전체를 막으면 맨 앞(0)이 나온다
        let all: Vec<usize> = (0..COLOR_COUNT).collect();
        assert_eq!(picker.acquire_avoiding(&all), 0);
        assert_eq!(picker.acquire_avoiding(&all), 1);
    }

    #[test]
    fn 새_레인이_왼쪽_빈_슬롯을_재사용해도_인접색을_피한다() {
        // 레인 0(색 0)과 레인 2(색 2)가 살아 있고 레인 1이 비는 상황을 만든다
        let commits = [
            commit("A", &["A1"]), // 레인 0
            commit("B", &[]),     // 레인 1, 바로 종료해 슬롯을 비운다
            commit("C", &["C1"]), // 레인 1 재사용... 이 아니라 새 tip
        ];
        let result = assign_lanes(&commits);
        // B가 끝나면서 레인 1이 비고, C가 그 자리를 다시 쓴다
        assert_eq!(
            result.rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
            vec![0, 1, 1]
        );
        // 왼쪽 이웃(레인 0)의 색과는 달라야 한다
        assert_ne!(result.rows[2].color, result.rows[0].color);
    }

    #[test]
    fn color_picker는_미사용_색을_먼저_쓰고_반납된_색을_재활용한다() {
        let mut picker = ColorPicker::new();
        let first: Vec<usize> = (0..COLOR_COUNT)
            .map(|_| picker.acquire_avoiding(&[]))
            .collect();
        assert_eq!(first, (0..COLOR_COUNT).collect::<Vec<_>>());

        picker.release(4);
        assert_eq!(
            picker.acquire_avoiding(&[]),
            4,
            "반납된 색이 다음 새 레인에 쓰인다"
        );

        // 색풀이 비면 0부터 순환한다
        assert_eq!(picker.acquire_avoiding(&[]), 0);
        assert_eq!(picker.acquire_avoiding(&[]), 1);
    }

    #[test]
    fn 색은_항상_0부터_9_사이다() {
        let mut commits = Vec::new();
        for i in 0..40 {
            commits.push(commit(&format!("T{i}"), &[&format!("P{i}")]));
        }
        let result = assign_lanes(&commits);
        assert!(result.rows.iter().all(|r| r.color < COLOR_COUNT));
        assert!(result
            .rows
            .iter()
            .all(|r| r.edges.iter().all(|e| e.color < COLOR_COUNT)));
    }

    #[test]
    fn 종료된_레인_슬롯을_왼쪽부터_재사용한다() {
        // A(레인 0), B(레인 1)로 벌어진 뒤 레인 0이 끝나면 다음 tip이 레인 0을 다시 쓴다
        let commits = [
            commit("A", &[]),    // 레인 0에서 바로 끝나는 루트
            commit("B", &["C"]), // 비어 있는 레인 0 재사용
            commit("C", &[]),
        ];
        let result = assign_lanes(&commits);
        assert_eq!(
            result.rows.iter().map(|r| r.lane).collect::<Vec<_>>(),
            vec![0, 0, 0]
        );
        assert_eq!(result.lane_count, 1);
    }

    #[test]
    fn 마지막_row_아래로_살아있는_레인은_계속_내려간다() {
        // 부모가 로드 범위 밖인 경우 (limit으로 잘린 상황)
        let commits = [commit("A", &["B"])];
        let result = assign_lanes(&commits);
        assert_eq!(
            result.rows[0].edges,
            vec![edge(0, 0, 0, 0, -1)],
            "부모가 로드 범위 밖이면 parent_row가 -1이다"
        );
    }

    #[test]
    fn octopus_머지도_부모마다_레인을_만든다() {
        let commits = [
            commit("O", &["P1", "P2", "P3"]),
            commit("P1", &[]),
            commit("P2", &[]),
            commit("P3", &[]),
        ];
        let result = assign_lanes(&commits);
        assert_eq!(result.lane_count, 3);

        // 세 선분 모두 머지 커밋(row 0)이 자식이고 부모 행만 다르다
        let band = &result.rows[0].edges;
        assert!(band.contains(&edge(0, 0, 0, 0, 1)), "{band:?}");
        assert!(band.contains(&edge(0, 1, 1, 0, 2)), "{band:?}");
        assert!(band.contains(&edge(0, 2, 2, 0, 3)), "{band:?}");
    }

    #[test]
    fn 같은_부모가_두_번_들어간_머지에도_선분이_중복되지_않는다() {
        let commits = [commit("M", &["P", "P"]), commit("P", &[])];
        let result = assign_lanes(&commits);
        let band = &result.rows[0].edges;
        assert_eq!(band.len(), 1, "중복 선분이 없어야 한다: {band:?}");
        assert_eq!(band[0], edge(0, 0, 0, 0, 1));
    }

    #[test]
    fn 모든_선분은_유효한_링크에_속한다() {
        let commits = [
            commit("M", &["Ma", "F"]),
            commit("Ma", &["B"]),
            commit("F", &["B"]),
            commit("B", &["A"]),
            commit("A", &["Z"]), // Z는 로드 범위 밖
        ];
        let result = assign_lanes(&commits);

        for (index, row) in result.rows.iter().enumerate() {
            for e in &row.edges {
                // 링크의 자식은 실재하는 행이다
                assert!(e.child_row < result.rows.len(), "{index}: {e:?}");
                // 부모는 미해결(-1)이거나 자식보다 아래 행이다 (topo 순서)
                assert!(
                    e.parent_row == -1 || e.parent_row > e.child_row as i64,
                    "{index}: {e:?}"
                );
                if e.parent_row >= 0 {
                    assert!(
                        (e.parent_row as usize) < result.rows.len(),
                        "{index}: {e:?}"
                    );
                }
                // 선분은 자기 band를 걸쳐 있는 링크에만 속한다
                assert!(e.child_row <= index, "{index}: {e:?}");
                assert!(
                    e.parent_row == -1 || e.parent_row > index as i64,
                    "{index}: {e:?}"
                );
            }
        }

        // A의 부모 Z는 로드되지 않아 마지막 band는 미해결이다
        let last = result.rows.last().unwrap();
        assert_eq!(last.edges, vec![edge(0, 0, 0, 4, -1)]);
    }

    #[test]
    fn 엣지의_레인_인덱스는_lane_count_안에_있다() {
        let commits = [
            commit("M", &["Ma", "F", "G"]),
            commit("Ma", &["B"]),
            commit("F", &["B"]),
            commit("G", &["B"]),
            commit("B", &["A"]),
            commit("A", &[]),
        ];
        let result = assign_lanes(&commits);
        for row in &result.rows {
            assert!(row.lane < result.lane_count);
            for e in &row.edges {
                assert!(e.from_lane < result.lane_count, "{e:?}");
                assert!(e.to_lane < result.lane_count, "{e:?}");
            }
        }
    }
}
