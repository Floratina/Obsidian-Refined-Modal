const ICON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='3' rx='2'/%3E%3Cpath d='M9 3v18'/%3E%3C/svg%3E")`;
const number = (key, css, value, min, max, unit = "px", step = 1) => ({ key: `nn${key}`, css, value, min, max, unit, step, type: "number" });
const text = (key, css, value, property) => ({ key: `nn${key}`, css, value, property, type: "text" });
const toggle = (key, css, value) => ({ key: `nn${key}`, css, value, type: "toggle" });

const NAVIGATOR_GROUPS = [
  { id: "behavior", options: [
    toggle("Enabled", null, true),
    toggle("DragEnabled", null, true),
    number("OpenDelay", null, 100, 0, 2000, "ms"),
    number("CloseDelay", null, 100, 0, 2000, "ms"),
    number("DragDelay", null, 150, 0, 2000, "ms"),
  ] },
  { id: "layout", options: [
    number("DrawerWidth", "drawer-width", 340, 120, 1000),
    text("DrawerHeight", "drawer-height", "min(820px, 100%)", "height"),
    number("OffsetTop", "offset-top", 4, 0, 100),
    number("OffsetLeft", "offset-left", 8, 0, 100),
    number("BottomGap", "bottom-gap", 20, 0, 200),
    number("ExitStrip", "exit-strip", 36, 0, 200),
    number("ButtonCardGap", "button-card-gap", 12, 0, 100),
    number("CardRadius", "card-radius", 8, 0, 80),
    number("ContentRadius", "content-radius", 16, 0, 80),
    number("PaddingTop", "padding-top", 8, 0, 80),
    number("PaddingInline", "padding-inline", 8, 0, 80),
    number("PaddingBottom", "padding-bottom", 12, 0, 80),
  ] },
  { id: "glass", options: [
    toggle("GlassEnabled", "glass-enabled", true),
    number("GlassOpacity", "glass-opacity", 70, 0, 100, "%"),
    number("GlassBlur", "glass-blur", 10, 0, 60),
    number("GlassBrightness", "glass-brightness", 1.1, 0, 3, "", 0.01),
    number("GlassSaturation", "glass-saturation", 1.2, 0, 3, "", 0.01),
    number("GlassContrast", "glass-contrast", 1.1, 0, 3, "", 0.01),
  ] },
  { id: "motion", options: [
    number("SlideDistance", "slide-distance", 10, 0, 100),
    number("ClosedScale", "closed-scale", 0.985, 0.5, 1.5, "", 0.001),
    text("ScaleOrigin", "scale-origin", "top left", "transform-origin"),
    number("EnterFadeDuration", "enter-fade-duration", 260, 0, 2000, "ms"),
    number("EnterSlideDuration", "enter-slide-duration", 260, 0, 2000, "ms"),
    number("EnterScaleDuration", "enter-scale-duration", 240, 0, 2000, "ms"),
    text("EnterEasing", "enter-easing", "cubic-bezier(0, 0.7, 0.36, 1)", "transition-timing-function"),
    number("ExitFadeDuration", "exit-fade-duration", 220, 0, 2000, "ms"),
    number("ExitSlideDuration", "exit-slide-duration", 220, 0, 2000, "ms"),
    number("ExitScaleDuration", "exit-scale-duration", 160, 0, 2000, "ms"),
    text("ExitEasing", "exit-easing", "cubic-bezier(.11,.25,.05,1.01)", "transition-timing-function"),
  ] },
  { id: "surface", collapsed: true, options: [
    text("CardSurface", "card-surface", "color-mix(in srgb, var(--nn-theme-nav-bg, var(--background-secondary)) 96%, var(--interactive-accent) 4%)", "background-color"),
    number("CardBorderWidth", "card-border-width", 1, 0, 10),
    text("CardBorderColor", "card-border-color", "color-mix(in srgb, var(--text-normal) 9%, transparent)", "border-color"),
    text("CardShadow", "card-shadow", "0 8px 24px rgb(0 0 0 / 16%), 0 2px 6px rgb(0 0 0 / 10%)", "box-shadow"),
    number("ShadowSpace", "shadow-space", 30, 0, 200),
    number("Layer", "layer", 20, 3, 49, ""),
  ] },
  { id: "button", collapsed: true, options: [
    text("ButtonIcon", "button-icon", ICON, "mask-image"),
    number("ButtonIconSize", "button-icon-size", 16, 8, 48),
    number("ButtonWidth", "button-width", 34, 16, 100),
    number("ButtonHeight", "button-height", 25, 16, 80),
    number("ToolbarHeight", "toolbar-height", 32, 20, 100),
    number("ButtonOffsetY", "button-offset-y", 0, -40, 40),
    text("ButtonColor", "button-color", "var(--nn-theme-header-button-icon-color, var(--text-muted))", "color"),
    text("ButtonHoverColor", "button-hover-color", "var(--nn-theme-header-button-icon-color, var(--text-muted))", "color"),
    number("ButtonOpacity", "button-opacity", 0.85, 0, 1, "", 0.01),
    number("ButtonHoverOpacity", "button-hover-opacity", 1, 0, 1, "", 0.01),
    text("ButtonHoverBg", "button-hover-bg", "var(--nn-theme-header-button-hover-bg, var(--background-modifier-hover))", "background-color"),
    text("ButtonRadius", "button-radius", "var(--radius-s, 4px)", "border-radius"),
    number("ToolbarGap", "toolbar-gap", 8, 0, 80),
    number("ButtonDuration", "button-duration", 120, 0, 2000, "ms"),
    text("ButtonEasing", "button-easing", "ease", "transition-timing-function"),
  ] },
];

const NAVIGATOR_OPTIONS = NAVIGATOR_GROUPS.flatMap((group) => group.options);
const NAVIGATOR_DEFAULTS = Object.fromEntries(NAVIGATOR_OPTIONS.map(({ key, value }) => [key, value]));
const NAVIGATOR_KEYS = new Set(Object.keys(NAVIGATOR_DEFAULTS));

function validNavigatorValue(option, value, css) {
  if (option.type === "toggle") return typeof value === "boolean";
  if (option.type === "number") return typeof value === "number" && Number.isFinite(value) && value >= option.min && value <= option.max;
  return typeof value === "string" && value.trim() !== "" && css.supports(option.property, value);
}

function normalizeNavigatorSettings(settings, css) {
  for (const option of NAVIGATOR_OPTIONS) {
    if (!validNavigatorValue(option, settings[option.key], css)) settings[option.key] = option.value;
  }
}

module.exports = { NAVIGATOR_GROUPS, NAVIGATOR_OPTIONS, NAVIGATOR_DEFAULTS, NAVIGATOR_KEYS, validNavigatorValue, normalizeNavigatorSettings };
