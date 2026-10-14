/**
 * Every font in the app one point larger (Juan, 2026-10-13): each px or rem
 * font-size the stylesheets declare, and Tailwind's --text-* sizes, gain 1px
 * at build time. Line heights and spacing stay as they are. The body default
 * (16px) is set in globals.css.
 */
const SIZE = /^([0-9.]+)(px|rem)$/;

function bump(value) {
  const m = SIZE.exec(value.trim());
  if (!m) return null;
  return m[2] === "px" ? `${parseFloat(m[1]) + 1}px` : `calc(${value.trim()} + 1px)`;
}

const largerText = () => ({
  postcssPlugin: "larger-text",
  Declaration(decl) {
    if (decl.__larger) return;
    const isSize = decl.prop === "font-size" || /^--text-[a-z0-9]+$/.test(decl.prop);
    if (!isSize) return;
    const next = bump(decl.value);
    if (!next) return;
    decl.value = next;
    decl.__larger = true;
  },
});
largerText.postcss = true;

module.exports = largerText;
