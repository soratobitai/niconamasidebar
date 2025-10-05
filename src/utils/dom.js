export function debounce(fn, delay) {
    let timerId = null;
    return function debounced(...args) {
        if (timerId) clearTimeout(timerId);
        timerId = setTimeout(() => {
            timerId = null;
            fn.apply(this, args);
        }, delay);
    };
}


