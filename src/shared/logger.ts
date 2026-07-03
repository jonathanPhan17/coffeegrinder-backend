import { Logger } from '@aws-lambda-powertools/logger';

// Structured logging for the workers (Powertools). Level via POWERTOOLS_LOG_LEVEL.
export const logger = new Logger({ serviceName: 'coffeegrinder' });
