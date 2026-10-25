import {getDistanceMeters} from './distance.js';
import {cumulativeOffsets, routeOffsetAt} from './routeMath.js';

export function dutyCoversCheckpoint(duty, checkpoint) {
  const distanceMeters = getDistanceMeters(
    Number(duty.latitude),
    Number(duty.longitude),
    Number(checkpoint.latitude),
    Number(checkpoint.longitude),
  );
  return {
    eligible: Number.isFinite(distanceMeters) && distanceMeters <= Number(duty.radius_m),
    distanceMeters,
  };
}

/**
 * Match an active police duty area to the remaining ambulance route.
 * This is intentionally independent from smart-speaker junctions: an officer can
 * be alerted when the route passes through their duty geofence even if no ESP32
 * junction is installed at that exact point.
 */
export function dutyRouteTarget(
  duty,
  routeCoords,
  currentOffsetMeters = 0,
  maxAheadDistanceMeters = Number.POSITIVE_INFINITY,
  corridorBufferMeters = 80,
) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) {
    return {eligible: false, reason: 'NO_ROUTE'};
  }
  const offsets = cumulativeOffsets(routeCoords);
  const match = routeOffsetAt(
    routeCoords,
    offsets,
    Number(duty.latitude),
    Number(duty.longitude),
  );
  const radius = Math.max(0, Number(duty.radius_m || 0));
  const routeDistanceMeters = Number(match.distanceMeters || 0);
  const routeOffsetMeters = Number(match.offsetMeters || 0);
  const aheadDistanceMeters = routeOffsetMeters - Number(currentOffsetMeters || 0);
  const intersectsRoute = routeDistanceMeters <= radius + Number(corridorBufferMeters || 0);
  const ahead = aheadDistanceMeters >= -radius && aheadDistanceMeters <= Number(maxAheadDistanceMeters);
  return {
    eligible: Boolean(intersectsRoute && ahead),
    routeDistanceMeters,
    routeOffsetMeters,
    aheadDistanceMeters,
    radiusMeters: radius,
  };
}

export function selectManualAlertCandidates(checkpoints, currentOffsetMeters, maxDistanceMeters, maxCount) {
  return checkpoints
    .map(cp => ({...cp, aheadDistanceMeters: Number(cp.route_offset_m) - Number(currentOffsetMeters || 0)}))
    .filter(cp => cp.aheadDistanceMeters >= 0 && cp.aheadDistanceMeters <= Number(maxDistanceMeters))
    .sort((a, b) => a.aheadDistanceMeters - b.aheadDistanceMeters)
    .slice(0, Math.max(1, Number(maxCount) || 1));
}
