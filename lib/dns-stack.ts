import { CfnOutput, Fn, Stack, type StackProps } from 'aws-cdk-lib';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

export interface DnsStackProps extends StackProps {
  config: EnvConfig;
}

/**
 * The domain's DNS home: the Route 53 hosted zone every site record (and the
 * certificate validation) lives in. Registration stays at the external registrar;
 * this zone answers for the domain once the registrar's nameservers point at it.
 * Deployed on its own first so that handoff can happen before the certificate —
 * which proves ownership through this zone — ever tries to issue.
 */
export class DnsStack extends Stack {
  readonly zone: HostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    this.zone = new HostedZone(this, 'SiteZone', {
      zoneName: props.config.frontendDomain,
    });

    // The four values to paste into the registrar's custom-nameservers form.
    new CfnOutput(this, 'NameServers', {
      value: Fn.join(', ', this.zone.hostedZoneNameServers ?? []),
    });
  }
}
