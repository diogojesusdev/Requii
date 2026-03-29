declare module 'textarea-caret-position' {
    export default class CaretCoordinates {
        constructor(element: HTMLInputElement | HTMLTextAreaElement);
        div?: HTMLDivElement;
        get(positionLeft: number, positionRight: number): { top: number; left: number; right: number };
    }
}
