export function processHulls(labels, points, pointSelector = (d) => d) {
  if (!labels || !points) return [];
  return labels
    .filter((d) => d?.hull)
    .map((d) => {
      return d.hull.map((i) => pointSelector(points[i])).filter((d) => !!d);
    });
}

// let's warn mobile users (on demo in read-only) that desktop is better experience
export const isMobileDevice = () => {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
};

// Debounce function without importing all of lodash
export const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
};
