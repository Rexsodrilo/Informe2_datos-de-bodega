# Dashboard de Despachos — v2

## Estructura

```
index.html
styles.css
js/
  main.js          orquesta pestañas, eventos y carga de archivo
  dataLoader.js     lee y normaliza Corte / Desp / Cont_Hodo desde el Excel
  businessDates.js  cálculo de fecha compromiso (48h hábiles, corte 15:00)
  kanban.js         lógica y render del tablero Kanban
  kpi.js            cálculo y render de los 8 indicadores (con gráficos)
  detalle.js        tabla resumida por NV + exportación a CSV
  auth.js           restricción simple del botón de carga
```

## Antes de publicar

1. **Cambia la contraseña de carga.** En `js/auth.js`, reemplaza
   `UPLOAD_PASSWORD_HASH` por el hash de tu propia contraseña. Para
   generarlo, abre la consola del navegador (F12) en cualquier página y
   ejecuta:
   ```js
   crypto.subtle.digest('SHA-256', new TextEncoder().encode('tu_clave'))
     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
   ```
   Copia el resultado en `UPLOAD_PASSWORD_HASH`. La contraseña de ejemplo
   que viene configurada es `despacho2026` — **cámbiala**.

2. **Recuerda que esto es una restricción simple, no autenticación real**
   (ver comentario en `auth.js`). Cualquiera con acceso al código fuente del
   sitio puede verla. Es proporcional para un informe interno, no para datos
   críticos.

3. **Repositorio público vs. privado.** GitHub Pages en el plan gratuito es
   público: cualquiera con el link puede ver los datos que publiques
   (nombres de clientes, montos, vendedores). Evalúen si esto es aceptable
   para la primera etapa o si conviene un repo privado (requiere plan
   pagado) antes de subir datos reales.

## Cómo probar localmente

No se puede abrir `index.html` con doble clic porque los módulos ES
(`type="module"`) requieren servirse por HTTP. Desde la carpeta del
proyecto:

```
python3 -m http.server 8000
```

y abre `http://localhost:8000` en el navegador.

## Cómo publicar en GitHub Pages

1. Sube estos archivos a un repositorio de GitHub (rama `main`).
2. En el repo: Settings → Pages → Source: rama `main`, carpeta `/ (root)`.
3. GitHub entrega una URL pública del tipo
   `https://tu-usuario.github.io/nombre-repo/`.
4. Cada vez que subas una nueva versión de los datos (ver flujo abajo),
   haz commit y push de los cambios; la página se actualiza sola en un
   par de minutos.

## Flujo de actualización de datos (pendiente de definir en detalle)

Hoy, al cargar el Excel con el botón "Actualizar datos", los datos quedan
disponibles **solo en tu navegador** (se guardan en `localStorage` para que
no se pierdan si recargas la página en tu equipo). Para que el resto de la
gerencia los vea, **todavía falta el paso de publicación al repositorio**
que definimos como arquitectura (Opción C): que al cargar el archivo se
genere un archivo de datos (por ejemplo JSON) que subas/hagas commit al
repo. Ese paso de exportación y publicación no está automatizado aún —
próximo punto a construir.

## Supuestos a validar con datos reales

- Nombres y posición de columnas: se resuelven por nombre normalizado
  (no por letra de columna), y la fila de encabezado de cada hoja se
  detecta automáticamente — así que cambios menores de estructura no
  deberían romper la lectura. Aun así, conviene probar con un archivo
  real completo antes de dar por cerrado el módulo de datos.
- Reglas de clasificación del Kanban (Programado / Por Programar / En
  Despacho) se definieron de forma razonable pero no fueron tan discutidas
  en detalle como las de KPI — revisar si calzan con la operación real.
- Días hábiles: solo excluye sábado y domingo, sin calendario de feriados
  (así se acordó "por ahora").
