# Certificados SOLO PARA PRUEBAS (no son de Apple)

Estos archivos imitan la cadena de certificados con la que Apple firma las compras de StoreKit 2
(raíz → intermedio → hoja). Sirven para probar `verificar_compras.js` sin comprar nada de verdad.

- No tienen ningún valor fuera de las pruebas: la clave privada `hoja_prueba.key` es pública a propósito.
- El servidor **solo** los acepta si arranca con `IAP_ALLOW_TEST_ROOT=1` y `IAP_TEST_ROOT_SHA256=<huella>`.
  Render NUNCA debe tener esas variables. Sin ellas, el servidor solo acepta compras firmadas por
  **Apple Root CA - G3** (huella fija en el código).
- `hoja_sin_oid.pem` es una hoja sin la marca de Apple para comprobar que se rechaza.
