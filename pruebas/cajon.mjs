// CKFast conserva identidad y consulta S tras incertidumbre; nunca vuelve a crear C.
// Casos de rechazo y pérdida de respuesta: seguridad.test.mjs.
import { probarServicio } from './servicio-seguro.mjs';
await probarServicio(process.argv[2], 'ckmonitor');
