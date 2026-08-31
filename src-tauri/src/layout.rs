//! 커밋 그래프 레인 배치. git을 실행하지 않는 순수 계산이다.
//!
//! 입력은 topo 순서(자식이 먼저) 커밋 목록이고, 출력은 각 row의 레인/색과
//! "row i와 row i+1 사이 구간(band)"에 그릴 선분 목록이다. 프론트는 계산 없이 그린다.
//!
//! @see CONTRACTS.md

use std::collections::VecDeque;

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

    fn acquire(&mut self) -> usize {
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

/// 직전 row를 처리한 뒤의 상태. band (i-1, i) 선분을 만들 때 쓴다.
#[derive(Debug)]
struct Band {
    /// 직전 row 처리 직후의 활성 레인 스냅샷
    snapshot: Vec<Option<Slot>>,
    /// 병합 부모용으로 새로 만든 레인: (새 레인, 출발 레인)
    origins: Vec<(usize, usize)>,
    /// 이미 존재하는 레인으로 합류하는 병합 선분: (출발 레인, 도착 레인, 색)
    diagonals: Vec<(usize, usize, usize)>,
}

/// topo 순서 커밋 목록에 레인/색/엣지를 배정한다.
pub fn assign_lanes(commits: &[RawCommit]) -> LayoutResult {
    let mut lanes: Vec<Option<Slot>> = Vec::new();
    let mut picker = ColorPicker::new();
    let mut rows: Vec<RowLayout> = Vec::with_capacity(commits.len());
    let mut lane_count = 0usize;
    let mut band: Option<Band> = None;

    for commit in commits {
        // 1. 이 커밋을 기다리는 레인들. 가장 왼쪽이 커밋 점의 레인이 된다.
        let matches: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.as_ref().is_some_and(|s| s.expected == commit.sha))
            .map(|(index, _)| index)
            .collect();

        let (lane, color) = match matches.first() {
            Some(&first) => (first, lanes[first].as_ref().unwrap().color),
            // 기다리는 레인이 없으면 새 브랜치 tip이다.
            None => (alloc_slot(&mut lanes), picker.acquire()),
        };

        // 직전 row의 band는 이번 커밋의 레인을 알아야 확정된다.
        if let Some(previous) = band.take() {
            if let Some(row) = rows.last_mut() {
                row.edges = build_edges(&previous, &commit.sha, lane);
            }
        }

        // 2. 나머지 match는 이 커밋에서 끝난다. 색은 색풀로 돌려준다.
        for &index in matches.iter().skip(1) {
            if let Some(slot) = lanes[index].take() {
                picker.release(slot.color);
            }
        }

        // 3. 커밋 레인은 first parent를 기다린다. 루트면 레인이 끝난다.
        match commit.parents.first() {
            Some(first_parent) => {
                lanes[lane] = Some(Slot {
                    expected: first_parent.clone(),
                    color,
                });
            }
            None => {
                lanes[lane] = None;
                picker.release(color);
            }
        }

        // 4. 추가 부모(merge). 이미 기다리는 레인이 있으면 연결만, 없으면 새 레인을 만든다.
        let mut origins = Vec::new();
        let mut diagonals = Vec::new();
        for parent in commit.parents.iter().skip(1) {
            match find_waiting(&lanes, parent) {
                Some(index) => {
                    let existing_color = lanes[index].as_ref().unwrap().color;
                    diagonals.push((lane, index, existing_color));
                }
                None => {
                    let index = alloc_slot(&mut lanes);
                    let new_color = picker.acquire();
                    lanes[index] = Some(Slot {
                        expected: parent.clone(),
                        color: new_color,
                    });
                    origins.push((index, lane));
                }
            }
        }

        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        lane_count = lane_count.max(lanes.len()).max(lane + 1);

        rows.push(RowLayout {
            lane,
            color,
            edges: Vec::new(),
        });
        band = Some(Band {
            snapshot: lanes.clone(),
            origins,
            diagonals,
        });
    }

    // 마지막 row 아래 구간: 살아있는 레인은 화면 밖으로 계속 내려간다.
    if let Some(previous) = band.take() {
        if let Some(row) = rows.last_mut() {
            row.edges = build_edges(&previous, "", 0);
        }
    }

    LayoutResult {
        rows,
        lane_count: lane_count.max(1),
    }
}

fn alloc_slot(lanes: &mut Vec<Option<Slot>>) -> usize {
    match lanes.iter().position(Option::is_none) {
        Some(index) => index,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

fn find_waiting(lanes: &[Option<Slot>], sha: &str) -> Option<usize> {
    lanes
        .iter()
        .position(|slot| slot.as_ref().is_some_and(|s| s.expected == sha))
}

/// band 하나의 선분을 만든다.
///
/// - 새로 생긴 병합 레인은 출발점이 병합 커밋의 레인이다 (점에서 벌어지는 선)
/// - `next_sha`를 기다리는 레인은 도착점이 다음 커밋의 레인이다 (점으로 합류하는 선)
/// - 그 밖에는 수직 통과선이다
///
/// `next_sha`가 빈 문자열이면 다음 row가 없는 마지막 band다.
fn build_edges(band: &Band, next_sha: &str, next_lane: usize) -> Vec<Edge> {
    let mut edges: Vec<Edge> = Vec::new();

    for &(from, target, color) in &band.diagonals {
        let to = if ends_at_next(band, target, next_sha) {
            next_lane
        } else {
            target
        };
        push_unique(
            &mut edges,
            Edge {
                from_lane: from,
                to_lane: to,
                color,
            },
        );
    }

    for (index, slot) in band.snapshot.iter().enumerate() {
        let Some(slot) = slot else { continue };
        let from = band
            .origins
            .iter()
            .find(|(lane, _)| *lane == index)
            .map(|(_, origin)| *origin)
            .unwrap_or(index);
        let to = if ends_at_next(band, index, next_sha) {
            next_lane
        } else {
            index
        };
        push_unique(
            &mut edges,
            Edge {
                from_lane: from,
                to_lane: to,
                color: slot.color,
            },
        );
    }

    edges
}

fn ends_at_next(band: &Band, lane: usize, next_sha: &str) -> bool {
    if next_sha.is_empty() {
        return false;
    }
    band.snapshot
        .get(lane)
        .and_then(Option::as_ref)
        .is_some_and(|slot| slot.expected == next_sha)
}

fn push_unique(edges: &mut Vec<Edge>, edge: Edge) {
    if !edges.contains(&edge) {
        edges.push(edge);
    }
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

    fn edge(from_lane: usize, to_lane: usize, color: usize) -> Edge {
        Edge {
            from_lane,
            to_lane,
            color,
        }
    }

    #[test]
    fn 선형_히스토리는_레인_0에_수직선만_그린다() {
        // A -> B -> C (C가 루트)
        let commits = [commit("A", &["B"]), commit("B", &["C"]), commit("C", &[])];
        let result = assign_lanes(&commits);

        assert_eq!(result.lane_count, 1);
        assert!(result.rows.iter().all(|r| r.lane == 0 && r.color == 0));

        // band 0, 1은 통과 수직선, 마지막 band는 루트라 비어 있다
        assert_eq!(result.rows[0].edges, vec![edge(0, 0, 0)]);
        assert_eq!(result.rows[1].edges, vec![edge(0, 0, 0)]);
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
        assert_eq!(
            result.rows[0].edges,
            vec![edge(0, 0, 0), edge(0, 1, 1)],
            "머지 커밋 점에서 새 레인 1로 벌어지는 선이 있어야 한다"
        );

        // band(Ma, F): 레인 0은 B를 기다리며 통과, 레인 1은 다음 row(F)에서 끝난다
        assert_eq!(result.rows[1].edges, vec![edge(0, 0, 0), edge(1, 1, 1)]);

        // band(F, B): 두 레인이 모두 B를 기다린다. 레인 1은 커밋 레인 0으로 합류한다
        assert_eq!(
            result.rows[2].edges,
            vec![edge(0, 0, 0), edge(1, 0, 1)],
            "레인 1이 row B의 커밋 점으로 합류하는 선이 band(F, B)에 있어야 한다"
        );

        // band(B, A): 레인 1은 종료됐고 레인 0만 남는다
        assert_eq!(result.rows[3].edges, vec![edge(0, 0, 0)]);
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

        // 새 tip B는 band(A, B)에 선이 없다. 레인 0만 통과한다
        assert_eq!(result.rows[0].edges, vec![edge(0, 0, 0)]);
        // band(B, C): 레인 0이 C에서 끝나고, 레인 1은 D를 기다리며 통과
        assert_eq!(result.rows[1].edges, vec![edge(0, 0, 0), edge(1, 1, 1)]);
        // band(C, D): 레인 1이 D에서 끝난다 (자기 레인이라 수직선)
        assert_eq!(result.rows[2].edges, vec![edge(0, 0, 0), edge(1, 1, 1)]);
        // band(D, E): 두 레인이 E를 기다린다 → 레인 1은 레인 0으로 합류
        assert_eq!(result.rows[3].edges, vec![edge(0, 0, 0), edge(1, 0, 1)]);
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
        assert!(
            band.contains(&edge(1, 0, 0)),
            "이미 있는 레인 0으로 합류하는 선분이 있어야 한다: {band:?}"
        );
        assert!(
            band.contains(&edge(0, 0, 0)),
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
    fn color_picker는_미사용_색을_먼저_쓰고_반납된_색을_재활용한다() {
        let mut picker = ColorPicker::new();
        let first: Vec<usize> = (0..COLOR_COUNT).map(|_| picker.acquire()).collect();
        assert_eq!(first, (0..COLOR_COUNT).collect::<Vec<_>>());

        picker.release(4);
        assert_eq!(picker.acquire(), 4, "반납된 색이 다음 새 레인에 쓰인다");

        // 색풀이 비면 0부터 순환한다
        assert_eq!(picker.acquire(), 0);
        assert_eq!(picker.acquire(), 1);
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
            vec![edge(0, 0, 0)],
            "마지막 band에도 통과선을 내려 화면 밖으로 이어지게 한다"
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

        let band = &result.rows[0].edges;
        assert!(band.contains(&edge(0, 0, 0)), "{band:?}");
        assert!(band.contains(&edge(0, 1, 1)), "{band:?}");
        assert!(band.contains(&edge(0, 2, 2)), "{band:?}");
    }

    #[test]
    fn 같은_부모가_두_번_들어간_머지에도_선분이_중복되지_않는다() {
        let commits = [commit("M", &["P", "P"]), commit("P", &[])];
        let result = assign_lanes(&commits);
        let band = &result.rows[0].edges;
        assert_eq!(band.len(), 1, "중복 선분이 없어야 한다: {band:?}");
        assert_eq!(band[0], edge(0, 0, 0));
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
