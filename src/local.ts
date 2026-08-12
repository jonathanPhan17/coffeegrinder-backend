import { buildApp } from './app';

const port = Number(process.env.PORT ?? 3000);

// No API Gateway locally, so no JWT claims to read — run every request as a fixed
// local identity instead of 401ing.
buildApp({ identityExtractor: () => 'local-dev' })
  .listen({ port, host: '0.0.0.0' })
  .then((address) => console.log(`coffeegrinder api listening on ${address}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
