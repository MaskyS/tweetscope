export const mapSelectionDomain = [0, 1, 2, 3, 4];

// these will be used as indexes to map to colors and opacities and sizes
export const mapSelectionKey = {
  normal: 0,
  selected: 1,
  notSelected: 2,
  hovered: 3,
  hidden: 4,
};

export const baseColor = '#1C6C66';
export const baseColorDark = '#A2DECE';

export const mapSelectionColorsLight = [
  baseColor, // normaimage.pngl
  baseColor, // selected
  baseColor, // not selected
  '#3AA99F', // hovered
  '#FFFCF0', // hidden
];

export const mapSelectionColorsDark = [
  baseColorDark,
  baseColorDark,
  baseColorDark,
  baseColorDark,
  '#FFFCF0', // 99, hidden
];

export const mapSelectionOpacity = [
  0.75, // normal
  1,
  // 0.25, // not selected
  0.75, // not selected
  1, // hovered
  0, // hidden
];
export const mapPointSizeRange = [
  3, // normal
  5.5, // selected
  2, // not selected
  12.5, // hovered
  0, // hidden
];

export const contrastColor = '#879A39';
