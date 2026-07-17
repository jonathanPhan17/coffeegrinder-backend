import { Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

export interface FrontendCertStackProps extends StackProps {
  config: EnvConfig;
  zone: IHostedZone;
}

/**
 * TLS certificate for the site (apex + www), DNS-validated against the hosted zone
 * and auto-renewing. Its own stack because CloudFront only accepts certificates
 * issued in us-east-1 while the rest of the app deploys elsewhere — bin/app.ts pins
 * this stack's region and bridges the zone/cert handoffs with crossRegionReferences.
 */
export class FrontendCertStack extends Stack {
  readonly certificate: Certificate;

  constructor(scope: Construct, id: string, props: FrontendCertStackProps) {
    super(scope, id, props);

    this.certificate = new Certificate(this, 'SiteCertificate', {
      domainName: props.config.frontendDomain,
      subjectAlternativeNames: [`www.${props.config.frontendDomain}`],
      // Issuance blocks until the zone is live on the public internet — the
      // registrar nameserver handoff must be done before this stack deploys.
      validation: CertificateValidation.fromDns(props.zone),
    });
  }
}
