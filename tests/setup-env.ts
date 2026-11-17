/** Variables de entorno de prueba (valores falsos, nunca credenciales reales). */
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.SITE_URL = 'https://esdla.test';
process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
process.env.DATABASE_SSL = 'disable';
process.env.ENCRYPTION_KEYS = 'k1:eyahqE16uk7q/m9l5QZRcojZKxFJJuOjk7DPlxq9a84=,k0:cPpsnj5C1Zs/5461tJsrUDe8FT96JPRfBTDKiw86pYY=';
process.env.ENCRYPTION_ACTIVE_KEY = 'k1';
process.env.SESSION_SECRET = 'xwyKOw1jnoBu9UU2AtJOrnnigGXVngOf8gTIssacEELuQiZEkv6pAWLkmtOyJ90Z';
process.env.CSRF_SECRET = 'Uol7wRaU4fOgtIH-lvvJseniOOFVPeuxfFC8PQKB6GZT33eqgF-kKlvPXyHE03EH';
// Hash scrypt de la contraseña "frase-larga-de-prueba-123" (generado con npm run hash-password)
process.env.ADMIN_PASSWORD_HASH = 'scrypt$32768$8$1$o02E5Xu89i1XRRbusglOuw$Uj1t1bWUZ2AEMhtS_c_td-xTI1A2sCb5W3ePzbC6myg';
process.env.MP_ACCESS_TOKEN = 'APP_USR-0000000000000000-000000-test-token-no-real';
process.env.MP_WEBHOOK_SECRETS = 'secreto-nuevo-0123456789abcdef,test-webhook-secret-0123456789abcdef';
process.env.MP_REQUIRE_SIGNATURE = 'true';
process.env.ML_CLIENT_ID = '1234567890123456';
process.env.ML_CLIENT_SECRET = 'ml-client-secret-de-prueba';
process.env.ML_REDIRECT_URI = 'https://esdla.test/api/admin/ml/callback';
process.env.ML_SELLER_USER_ID = '987654321';
