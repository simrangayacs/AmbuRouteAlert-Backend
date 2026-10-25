import {getDistanceMeters} from '../utils/distance.js';
import {cumulativeOffsets, routeOffsetAt} from '../utils/routeMath.js';
import {dutyCoversCheckpoint, dutyRouteTarget, selectManualAlertCandidates} from '../utils/targeting.js';

const route = [[85.0,24.8],[85.001,24.8],[85.002,24.8]];
const offsets = cumulativeOffsets(route);
if (!(offsets[2] > offsets[1] && offsets[1] > 0)) throw new Error('Route offsets are invalid');
const here = routeOffsetAt(route, offsets, 24.8, 85.001);
if (here.index !== 1) throw new Error('Route point matching failed');
const d = getDistanceMeters(24.8,85.0,24.8,85.001);
if (!(d > 80 && d < 120)) throw new Error(`Distance sanity failed: ${d}`);

const duty = {latitude:24.7690, longitude:84.9830, radius_m:800};
const vishnupad = {latitude:24.7692, longitude:84.9832};
const far = {latitude:24.80, longitude:85.02};
if (!dutyCoversCheckpoint(duty, vishnupad).eligible) throw new Error('Nearby duty targeting failed');
if (dutyCoversCheckpoint(duty, far).eligible) throw new Error('Far-away duty should not be targeted');

const demoCorridor = [[85.0082,24.7982],[85.0074,24.7969],[84.9830,24.7690],[84.9685,24.7490]];
const dutyRoute = dutyRouteTarget(duty, demoCorridor, 0, 8000, 100);
if (!dutyRoute.eligible) throw new Error('Police duty area should intersect remaining demo route');
if (!(dutyRoute.aheadDistanceMeters >= 0)) throw new Error('Duty route target ahead distance invalid');

const candidates = selectManualAlertCandidates([
  {id:1, route_offset_m:500},
  {id:2, route_offset_m:2500},
  {id:3, route_offset_m:6500},
  {id:4, route_offset_m:9000},
], 100, 8000, 5);
if (candidates.length !== 3) throw new Error(`Manual candidate selection failed: ${candidates.length}`);
if (candidates[0].id !== 1 || candidates[2].id !== 3) throw new Error('Manual candidate ordering failed');

console.log('LOGIC SELF TEST PASSED: route math + junction targeting + route-corridor Police targeting + manual candidate selection');
