// The board's basemap: P1-phosphor linework on a black field, drawn like a vector
// situation display. An imagery underlay and the live geostationary view swap in beneath it.

export const INK = {
  field: '#020805',
  land: '#03110a',
  water: '#010403',
  coast: '#6dffa6',
  coastBloom: '#1fd673',
  border: '#3fbf78',
  border2: '#1d6b42',
  grid: '#0d3a24',
  road: '#1b5c3b',
  roadMajor: '#2f8f5c',
  rail: '#5a6b34',
  label: '#9dffc4',
  labelDim: '#4fa877',
  halo: '#010403',
  sun: '#ffb43b',
  white: '#e6fff0',
};

const FONT = ['Noto Sans Regular'];
const FONT_B = ['Noto Sans Bold'];
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];

export const IMAGERY = {
  esri: { label: 'ESRI WORLD IMAGERY', maxzoom: 18,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
};

// Imagery is pushed toward the phosphor palette rather than shown raw.
const IMG_PAINT = { 'raster-saturation': -0.55, 'raster-brightness-max': 0.78, 'raster-contrast': 0.12, 'raster-hue-rotate': 0, 'raster-fade-duration': 150 };

export const Z_IMAGE = 'sh-z-image';      // rendered scenes go below this
export const Z_BOARD = 'sh-z-board';      // board graphics go below this, labels stay on top

export function boardStyle() {
  return {
    version: 8,
    name: 'Shamash board',
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#010604', 'horizon-color': '#1ea862', 'fog-color': '#010604',
      'sky-horizon-blend': 0.55, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.25,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 4, 0.35, 7, 0],
    },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: 'OpenFreeMap · OpenMapTiles · © OpenStreetMap' },
      imagery: { type: 'raster', tileSize: 256, tiles: IMAGERY.esri.tiles, maxzoom: 18, attribution: 'Esri World Imagery' },
    },
    layers: [
      { id: 'field', type: 'background', paint: { 'background-color': INK.land } },
      { id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility: 'none' }, paint: IMG_PAINT },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': INK.water, 'fill-antialias': false } },
      { id: Z_IMAGE, type: 'background', layout: { visibility: 'none' } },

      { id: 'landuse-mil', type: 'line', source: 'omt', 'source-layer': 'landuse', minzoom: 9, filter: ['==', ['get', 'class'], 'military'],
        paint: { 'line-color': INK.sun, 'line-opacity': 0.5, 'line-width': 1, 'line-dasharray': [1, 2] } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 7,
        paint: { 'line-color': INK.coastBloom, 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 14, 1.4] } },
      // two-pass coastline: a wide blurred bloom under a crisp trace, like a phosphor beam
      { id: 'coast-bloom', type: 'line', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': INK.coastBloom, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.35, 5, 0.25, 8, 0.1, 11, 0.05], 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 4, 8, 6], 'line-blur': 4 } },
      { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': INK.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 8, 1.1, 14, 1.4] } },

      { id: 'building', type: 'line', source: 'omt', 'source-layer': 'building', minzoom: 14,
        paint: { 'line-color': INK.road, 'line-opacity': 0.8, 'line-width': 0.6 } },
      { id: 'aeroway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 10, filter: ['in', ['get', 'class'], ['literal', ['runway', 'taxiway']]],
        paint: { 'line-color': INK.white, 'line-opacity': 0.7,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'class'], 'runway', 1.2, 0.3], 15, ['match', ['get', 'class'], 'runway', 6, 1.5]] } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8, filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': INK.rail, 'line-width': 0.9, 'line-dasharray': [4, 2] } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'track', 'tertiary', 'secondary']]],
        paint: { 'line-color': INK.road, 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 16, 1.2] } },
      { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 6,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        paint: { 'line-color': INK.roadMajor, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 10, 0.85],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.2, 16, 2.2] } },

      { id: 'border-sub', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 4,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': INK.border2, 'line-width': 0.7, 'line-dasharray': [2, 3] } },
      { id: 'border', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['<=', ['coalesce', ['get', 'admin_level'], 99], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': INK.border, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 1, 12, 1.6], 'line-dasharray': [6, 2, 1, 2] } },
      { id: 'border-disputed', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['<=', ['coalesce', ['get', 'admin_level'], 99], 2], ['==', ['get', 'disputed'], 1]],
        paint: { 'line-color': INK.sun, 'line-opacity': 0.75, 'line-width': 1, 'line-dasharray': [1, 2] } },

      { id: Z_BOARD, type: 'background', layout: { visibility: 'none' } },

      { id: 'label-water', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 2, filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 9.5, 'text-transform': 'uppercase', 'text-letter-spacing': 0.4, 'text-max-width': 6 },
        paint: { 'text-color': '#1f6b45', 'text-halo-color': INK.halo, 'text-halo-width': 1 } },
      { id: 'label-airport', type: 'symbol', source: 'omt', 'source-layer': 'aerodrome_label', minzoom: 9,
        layout: { 'text-field': ['coalesce', ['get', 'icao'], ['get', 'iata'], NAME], 'text-font': FONT_B, 'text-size': 10, 'text-letter-spacing': 0.15, 'text-offset': [0, 0.9] },
        paint: { 'text-color': INK.white, 'text-halo-color': INK.halo, 'text-halo-width': 1.5 } },
      { id: 'label-place', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village']]],
        layout: {
          'text-field': NAME, 'text-font': FONT, 'text-transform': 'uppercase', 'text-letter-spacing': 0.14,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, ['match', ['get', 'class'], 'city', 9.5, 0], 8, ['match', ['get', 'class'], 'city', 12, 'town', 9.5, 0], 12, ['match', ['get', 'class'], 'city', 14, 'town', 11.5, 10]],
          'text-anchor': 'left', 'text-offset': [0.7, 0], 'text-max-width': 9, 'symbol-sort-key': ['coalesce', ['get', 'rank'], 20],
          'icon-image': 'sh-pip', 'icon-size': 1, 'icon-allow-overlap': false,
        },
        paint: { 'text-color': INK.label, 'text-halo-color': INK.halo, 'text-halo-width': 1.5 } },
      { id: 'label-state', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4, maxzoom: 8, filter: ['==', ['get', 'class'], 'state'],
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 9.5, 'text-transform': 'uppercase', 'text-letter-spacing': 0.32, 'text-max-width': 7 },
        paint: { 'text-color': INK.labelDim, 'text-halo-color': INK.halo, 'text-halo-width': 1 } },
      { id: 'label-country', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 1.5, maxzoom: 8, filter: ['==', ['get', 'class'], 'country'],
        layout: { 'text-field': NAME, 'text-font': FONT_B, 'text-transform': 'uppercase', 'text-letter-spacing': 0.3, 'text-max-width': 7,
          'text-size': ['interpolate', ['linear'], ['zoom'], 1.5, 8.5, 5, 12.5], 'symbol-sort-key': ['coalesce', ['get', 'rank'], 10] },
        paint: { 'text-color': INK.labelDim, 'text-halo-color': INK.halo, 'text-halo-width': 1.5 } },
    ],
  };
}

/** Tune linework for the vector board, an imagery underlay or the live weather view. */
export function applyBase(map, mode) {
  const img = mode !== 'vector';
  map.setLayoutProperty('imagery', 'visibility', mode === 'imagery' ? 'visible' : 'none');
  map.setPaintProperty('water', 'fill-opacity', img ? 0 : 1);
  map.setPaintProperty('coast-bloom', 'line-opacity', img ? 0.12 : ['interpolate', ['linear'], ['zoom'], 0, 0.35, 5, 0.25, 8, 0.1, 11, 0.05]);
  map.setPaintProperty('coast', 'line-opacity', mode === 'live' ? 0.75 : img ? 0.5 : 1);
  map.setPaintProperty('road-minor', 'line-opacity', img ? 0.35 : 0.75);
  map.setPaintProperty('building', 'line-opacity', img ? 0 : 0.8);
  map.setPaintProperty('label-place', 'text-color', img ? INK.white : INK.label);
  map.setPaintProperty('label-country', 'text-color', img ? INK.white : INK.labelDim);
}
