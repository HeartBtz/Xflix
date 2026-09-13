# Contributing to XFlix

Contributions are welcome. Please open an issue before starting a large change.

## Development

1. Fork and clone `https://github.com/HeartBtz/Xflix`.
2. Create a focused branch from `main`.
3. Run `npm ci --ignore-scripts --include=optional`.
4. Copy `.env.example` to `.env` and use disposable media and database data.
5. Make the smallest change that solves the problem and add regression tests.
6. Run `npm run check` and, when available, `npm run test:browser`.
7. Open a pull request with the motivation, behavior changes, and test results.

Use CommonJS for backend code, parameterize SQL values, and keep the frontend
framework-free. Never include credentials, personal media, private URLs, host
inventory, or production logs in issues, tests, screenshots, or pull requests.

By contributing, you agree that your contribution is licensed under the MIT
License.
