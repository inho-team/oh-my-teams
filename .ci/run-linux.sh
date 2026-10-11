#!/bin/sh

node --version
npm ci || exit $?

failed=0
npm run quality || failed=1
npm run format:check || failed=1
npm test || failed=1
exit "$failed"
