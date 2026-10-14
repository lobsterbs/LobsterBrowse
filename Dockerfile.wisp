# Standalone wisp backend for the ScramJet engine option: the official
# @mercuryworkshop/wisp-js server CLI, unmodified. LB's own /wisp/
# endpoint keeps its password auth (engine clients cannot send
# credentials); ScramJet's libcurl transport has no password support
# either, so a public unauthenticated wisp IS the upstream scramjet
# deployment model. SSRF posture: wisp-js defaults refuse private and
# loopback destinations (src/server/options.mjs).
# Render deploys this from the same repo with dockerfilePath
# ./Dockerfile.wisp; the service URL goes into the main service's
# SCRAMJET_WISP_URL (reported by /build as sjWisp).
FROM node:22-slim
RUN npm install -g @mercuryworkshop/wisp-js@0.5.0
ENV PORT=10000
EXPOSE 10000
CMD ["wisp-js-server", "-H", "0.0.0.0"]
