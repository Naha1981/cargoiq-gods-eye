# CargoIQ Live Harbour View (Phase 0 proof)

Standalone proof page for a live harbour picture: vessels around
Durban and Richards Bay on a satellite globe, one fictional disputed container pinned
(case DUR-2026-0412), fly-to views. Separate from the production CargoIQ app.

- Static site (repo root) is served by GitHub Pages; proxied at nahalabs.co.za/harbour-view.
- `server/` is a small Node WebSocket relay (Render free web service). The browser never
  sees the AISStream key (AISStream keys are server-side only). The relay keeps one
  upstream connection, caches latest positions, and fans out to viewers.
- If the relay is cold/unreachable the page falls back to `data/vessels-snapshot.json`
  and labels itself SNAPSHOT.

Data sources: AISStream (AIS), Esri World Imagery, Re:Earth Terrain, CesiumJS (Apache-2.0).
The pinned disputed container is fictional sample data. No customer data.
