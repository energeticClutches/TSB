import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

/** Free OpenStreetMap-based tiles, no key or billing (Phase 5: MapLibre + OpenFreeMap). */
const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
/** Sector-6 Market, Bahadurgarh: where the map opens before the customer shares a location. */
export const DEFAULT_CENTER = { lat: 28.6923, lng: 76.9239 };

/**
 * C4a: drag the pin (or tap the map) to where the order should go. The server works out the
 * distance from the shop; this map only picks the point. Loaded only for delivery orders.
 */
export default function DeliveryMap({ value, onChange }: { value: { lat: number; lng: number } | undefined; onChange: (p: { lat: number; lng: number }) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const pin = useRef<maplibregl.Marker | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const start = value ?? DEFAULT_CENTER;
    const m = new maplibregl.Map({ container: box.current!, style: STYLE, center: [start.lng, start.lat], zoom: value ? 16 : 14, attributionControl: { compact: true } });
    const marker = new maplibregl.Marker({ color: '#E6007A', draggable: true }).setLngLat([start.lng, start.lat]).addTo(m);
    const emit = (ll: maplibregl.LngLat) => changed.current({ lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) });
    marker.on('dragend', () => emit(marker.getLngLat()));
    m.on('click', (e: maplibregl.MapMouseEvent) => {
      marker.setLngLat(e.lngLat);
      emit(e.lngLat);
    });
    map.current = m;
    pin.current = marker;
    return () => m.remove();
    // The map is created once; later location changes move the pin below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!value || !pin.current || !map.current) return;
    const cur = pin.current.getLngLat();
    if (Math.abs(cur.lat - value.lat) < 1e-6 && Math.abs(cur.lng - value.lng) < 1e-6) return;
    pin.current.setLngLat([value.lng, value.lat]);
    map.current.flyTo({ center: [value.lng, value.lat], zoom: 16 });
  }, [value]);

  return <div ref={box} className="h-56 w-full overflow-hidden rounded-2xl" role="application" aria-label="Map: drag the pin to your door" />;
}
