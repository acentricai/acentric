// Applies a chosen theme before the first paint, so a dark-mode reader never
// sees a white flash. Kept outside the bundle so it runs before React loads.
try {
  var theme = localStorage.getItem('acentric-docs-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be unavailable; the system theme applies.
}
