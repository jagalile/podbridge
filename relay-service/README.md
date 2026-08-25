# podbridge-relay

Servicio de relevo para episodios grandes de PodBridge. Instrucciones
completas de qué es esto, por qué existe y cómo desplegarlo en
[Render.com](https://render.com) en el README principal del repositorio,
sección **"Episodios muy grandes"** → **"Desplegar el servicio de
relevo"**.

Resumen rápido:

- No tiene dependencias de npm — solo Node 18+.
- Una sola tarea: descargar un mp3 público de iVoox y subirlo a una URL
  de Pocket Casts ya autorizada, en streaming, sin guardar nada en disco.
- Nunca ve tu email, contraseña ni token de Pocket Casts.
- Variables de entorno: `RELAY_SECRET` (obligatoria, un secreto que
  también pegas en Ajustes de PodBridge) y `ALLOWED_ORIGIN` (opcional,
  restringe qué origen puede llamarlo — pon la URL de tu GitHub Pages).

## Probarlo en local

```bash
cd relay-service
RELAY_SECRET=loquesea npm start
# en otra terminal:
curl http://localhost:3000/health
```
