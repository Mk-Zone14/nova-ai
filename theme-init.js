(() => {
  try {
    document.documentElement.dataset.theme = localStorage.getItem('opportunity-theme') || 'dark';
  } catch {
    document.documentElement.dataset.theme = 'dark';
  }
})();
