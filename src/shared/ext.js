// The browser's extension API under one name. Firefox calls it `browser`; Chrome, Brave, Edge and Opera call it
// `chrome`. In Manifest V3 both return promises, and every call plum makes exists in both.
export const ext = () => globalThis.browser ?? globalThis.chrome;
