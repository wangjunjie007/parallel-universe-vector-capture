import {
  FINGER_NAMES,
  HAND_IDS,
  pointId,
  type GeometryEdge,
  type GeometryFace,
  type GeometryHintFrame,
  type GestureState,
  type SemanticFrame,
  type SemanticPoint,
} from './types';

function edgeId(from: string, to: string): string {
  return [from, to].sort().join('--');
}

function addEdge(edges: Map<string, GeometryEdge>, from: string, to: string, kind: GeometryEdge['kind']): void {
  if (from === to) return;
  const id = edgeId(from, to);
  if (!edges.has(id)) edges.set(id, { id, from, to, kind });
}

function orderedPoints(points: SemanticPoint[]): SemanticPoint[] {
  const rank = new Map(FINGER_NAMES.map((finger, index) => [finger, index]));
  return [...points].sort((a, b) => {
    const side = a.side.localeCompare(b.side);
    if (side !== 0) return side;
    return (rank.get(a.finger) ?? 99) - (rank.get(b.finger) ?? 99);
  });
}

function stableFace(faceId: string, pointIds: string[], topology: GeometryFace['topology']): GeometryFace {
  return { face_id: faceId, point_ids: [...pointIds], topology, stable: true };
}

/**
 * Build preview/export geometry hints from semantic identities.  This function
 * deliberately does not infer arbitrary rectangles from point coordinates.
 */
export function buildGeometryHint(frame: Pick<SemanticFrame, 'frame' | 'time' | 'state' | 'count' | 'points' | 'extendedPoints'>): GeometryHintFrame {
  // Strict portal points remain 4 during partial-open for Skill compatibility,
  // but geometry must expose the confirmed extended fingers as partial topology.
  const sourcePoints = frame.state === 'partial_open' ? frame.extendedPoints : frame.points.length > 0 ? frame.points : frame.extendedPoints;
  const unique = new Map<string, SemanticPoint>();
  const warnings: string[] = [];
  for (const point of sourcePoints) {
    const id = pointId(point);
    if (unique.has(id)) warnings.push(`duplicate_point:${id}`);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) warnings.push(`non_finite_point:${id}`);
    unique.set(id, point);
  }
  const points = orderedPoints([...unique.values()]);
  const pointIds = points.map(pointId);
  const edges = new Map<string, GeometryEdge>();
  const faces: GeometryFace[] = [];

  if (frame.count === 4 && frame.state !== 'partial_open' && pointIds.length >= 4) {
    const desired = ['hand_1:thumb', 'hand_1:index', 'hand_2:index', 'hand_2:thumb'];
    const quad = desired.every((id) => unique.has(id)) ? desired : pointIds.slice(0, 4);
    if (quad.length === 4) {
      for (let index = 0; index < quad.length; index += 1) addEdge(edges, quad[index], quad[(index + 1) % quad.length], 'perimeter');
      faces.push(stableFace('portal-4', quad, 'quad'));
    } else {
      warnings.push('quad_requires_four_unique_points');
    }
  } else if (frame.count === 10 && pointIds.length >= 10) {
    const complete = pointIds.slice(0, 10);
    for (let left = 0; left < complete.length; left += 1) {
      for (let right = left + 1; right < complete.length; right += 1) addEdge(edges, complete[left], complete[right], 'complete');
    }
    if (edges.size !== 45) warnings.push(`complete_graph_expected_45_got_${edges.size}`);
    faces.push(stableFace('portal-10', complete, 'complete'));
  } else {
    // Partial states preserve identity topology: adjacent fingers on a hand
    // are connected, and matching fingers may connect across hands.
    for (const side of HAND_IDS) {
      const sidePoints = FINGER_NAMES.map((finger) => `${side}:${finger}`).filter((id) => unique.has(id));
      for (let index = 0; index + 1 < sidePoints.length; index += 1) addEdge(edges, sidePoints[index], sidePoints[index + 1], 'internal');
      if (sidePoints.length >= 3) faces.push(stableFace(`partial-${side}`, sidePoints, 'partial'));
    }
    for (const finger of FINGER_NAMES) {
      const left = `hand_1:${finger}`;
      const right = `hand_2:${finger}`;
      if (unique.has(left) && unique.has(right)) addEdge(edges, left, right, 'corresponding');
    }
  }

  if (frame.count === 4 && frame.state !== 'partial_open' && pointIds.length !== 4) warnings.push(`count_4_point_length_${pointIds.length}`);
  if (frame.count === 10 && pointIds.length !== 10) warnings.push(`count_10_point_length_${pointIds.length}`);
  if (frame.count === 0 && pointIds.length > 0) warnings.push('count_zero_with_points');
  return {
    frame: frame.frame,
    time: frame.time,
    state: frame.state,
    point_ids: pointIds,
    edges: [...edges.values()],
    faces,
    quality: { valid: warnings.length === 0, warnings },
  };
}

export function buildGeometryHints(frames: SemanticFrame[]): GeometryHintFrame[] {
  return [...frames].sort((a, b) => a.frame - b.frame).map(buildGeometryHint);
}

export function geometryHintsToNdjson(hints: GeometryHintFrame[]): string {
  return hints.map((hint) => JSON.stringify(hint)).join('\n') + (hints.length > 0 ? '\n' : '');
}

export function geometryStateForCount(count: 0 | 4 | 10): GestureState {
  if (count === 10) return 'all_open';
  if (count === 4) return 'pinch';
  return 'none';
}
