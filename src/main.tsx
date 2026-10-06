// Route before importing the main workspace: the pet does not need editors,
// charts, plugin views or the full application stylesheet to show its first frame.
const view = new URLSearchParams(window.location.search).get('view');
const entry = view === 'screenshot' ? import('./screenshot/entry') : view === 'pet' ? import('./pet/entry') : import('./app-entry');
void entry.catch(error => {
  console.error('Failed to load Sage view', error);
  const root = document.getElementById('root');
  if (root) root.textContent = 'Sage could not load. Please reopen the window.';
});
