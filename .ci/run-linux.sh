#!/bin/sh

node --version
npm ci || exit $?

npm run verify
