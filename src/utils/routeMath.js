import {getDistanceMeters} from './distance.js';

export function cumulativeOffsets(coords) {
  const offsets=[0];
  for(let i=1;i<coords.length;i++) {
    const [lon1,lat1]=coords[i-1]; const [lon2,lat2]=coords[i];
    offsets.push(offsets[i-1]+getDistanceMeters(lat1,lon1,lat2,lon2));
  }
  return offsets;
}

export function nearestRoutePoint(coords, lat, lon) {
  let bestIndex=0, bestDistance=Number.POSITIVE_INFINITY;
  for(let i=0;i<coords.length;i++) {
    const [rlon,rlat]=coords[i];
    const d=getDistanceMeters(lat,lon,rlat,rlon);
    if(d<bestDistance){bestDistance=d;bestIndex=i;}
  }
  return {index:bestIndex,distanceMeters:bestDistance};
}

export function routeOffsetAt(coords, offsets, lat, lon) {
  const nearest=nearestRoutePoint(coords,lat,lon);
  return {...nearest,offsetMeters:Math.round(offsets[nearest.index]||0)};
}
