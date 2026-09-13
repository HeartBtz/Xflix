FROM mcr.microsoft.com/playwright:v1.63.0-noble
COPY --chown=pwuser:pwuser . /app
USER pwuser
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
CMD ["npm", "run", "test:browser"]
