# The console as a container, so the host is a choice rather than a commitment.
#
# This is a long-running HTTP server, not a set of functions. `createConsole`
# holds three in-memory ledgers and one fake transport for the life of the
# process, because replaying an idempotency key has to find the call the
# earlier request created. On a platform that hands each request to a fresh
# instance that lookup misses, and the console's own "run it again, nothing
# re-dials" claim stops being true — which is worse than not making it.
#
# Anywhere that runs this image and sets PORT will work.
#
#   docker build -t holdline .
#   docker run -p 4173:4173 -e PORT=4173 holdline
#
# There is deliberately no CALLE_API_KEY here, and setting one would not
# matter: HOLDLINE_CONSOLE_HOST is 0.0.0.0 below, and src/console/run.ts locks
# any console bound off loopback into simulation. A visitor cannot spend
# credits or ring anybody, by construction rather than by configuration.

FROM node:20-alpine AS build
WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# `npm run build` emits JavaScript and copies the two HTML pages beside it.
# Nothing else in the tree is read at runtime, and the devDependencies that
# compiled it are not carried forward.
RUN npm prune --omit=dev


FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Not root: this process serves the public internet and writes nothing.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Binding off loopback is what forces simulation. It is set here rather than
# left to the deployment config, so an image that reaches the internet cannot
# be started in a mode that dials.
ENV HOLDLINE_CONSOLE_HOST=0.0.0.0
ENV PORT=8000
EXPOSE 8000

CMD ["node", "dist/console/run.js"]
