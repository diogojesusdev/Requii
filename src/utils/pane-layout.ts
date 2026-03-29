import {
    CENTER_PANE_MIN_WIDTH,
    DEFAULT_PANE_SIZES,
    LEFT_PANE_MIN_WIDTH,
    PANE_STORAGE_KEY,
    RIGHT_PANE_MIN_WIDTH,
    SPLITTER_WIDTH,
} from '../constants';

export function readStoredPaneSizes() {
    if (typeof window === 'undefined') {
        return DEFAULT_PANE_SIZES;
    }

    try {
        const rawValue = window.localStorage.getItem(PANE_STORAGE_KEY);
        if (!rawValue) {
            return DEFAULT_PANE_SIZES;
        }

        const parsed = JSON.parse(rawValue);
        if (typeof parsed?.left === 'number' && typeof parsed?.right === 'number') {
            return {
                left: parsed.left,
                right: parsed.right,
            };
        }
    } catch {
        return DEFAULT_PANE_SIZES;
    }

    return DEFAULT_PANE_SIZES;
}

export function clampPaneSizes(nextSizes, containerWidth) {
    if (!containerWidth) {
        return nextSizes;
    }

    const maxLeft = Math.max(LEFT_PANE_MIN_WIDTH, containerWidth - RIGHT_PANE_MIN_WIDTH - CENTER_PANE_MIN_WIDTH - SPLITTER_WIDTH * 2);
    const left = Math.min(Math.max(nextSizes.left, LEFT_PANE_MIN_WIDTH), maxLeft);
    const maxRight = Math.max(RIGHT_PANE_MIN_WIDTH, containerWidth - left - CENTER_PANE_MIN_WIDTH - SPLITTER_WIDTH * 2);
    const right = Math.min(Math.max(nextSizes.right, RIGHT_PANE_MIN_WIDTH), maxRight);

    return { left, right };
}
