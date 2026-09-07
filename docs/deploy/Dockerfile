FROM node:22-bookworm-slim AS runtime

ARG RELEASE_SHA
ARG SOURCE_REPOSITORY="https://github.com/crizpy7-sketch/Michel-OS"

RUN node -e "const sha=process.env.RELEASE_SHA??'';if(!/^[0-9a-f]{40}$/i.test(sha)){console.error('RELEASE_SHA must be an exact 40-character Git SHA');process.exit(1)}"

LABEL org.opencontainers.image.revision="${RELEASE_SHA}" \
      org.opencontainers.image.source="${SOURCE_REPOSITORY}"

ENV NODE_ENV=production
ENV MICHEL_RELEASE_SHA="${RELEASE_SHA}"
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node . .

USER node
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
