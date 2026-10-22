// Sustituye las expectativas antiguas de reintento tras corte o atasco (inseguras).
// Casos detallados: seguridad.test.mjs y protocolo-seguro.test.mjs.
import { probarServicio } from './servicio-seguro.mjs';
await probarServicio(process.argv[2], 'directo');
