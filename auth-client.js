window.brickonSession = (async () => {
  const result = await fetch("/api/auth?action=yo", { credentials: "same-origin" });
  if (result.ok) return result.json();
  location.replace(`/api/auth?action=login&next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
  throw new Error("No autenticado");
})();
