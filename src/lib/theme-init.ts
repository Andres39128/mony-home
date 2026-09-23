/**
 * Anti-FOUC theme bootstrap, shared by the root layout and global-error
 * (which renders its own document and would otherwise lose the saved theme).
 * Runs during HTML parsing, before first paint: saved theme wins, else the
 * OS preference.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
