import { useCallback, useEffect, useRef } from 'react';

const useDebounce = (callback, delay) => {
  const timeoutRef = useRef(null);

  const cancel = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const debounced = useCallback(
    (...args) => {
      cancel();

      timeoutRef.current = setTimeout(() => {
        callback(...args);
        timeoutRef.current = null;
      }, delay);
    },
    [callback, delay, cancel]
  );

  useEffect(() => cancel, [cancel]);

  debounced.cancel = cancel;
  return debounced;
};

export default useDebounce;
