import * as digitalocean from "@pulumi/digitalocean";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as utils from "./utils";

// Get the DO API token from the digitalocean config namespace.
const doConfig = new pulumi.Config("digitalocean");
const adminApiToken = doConfig.requireSecret("token");

// Enable default cluster settings for the project's config namespace.
const config = new pulumi.Config();
const nodeCount = config.getNumber("nodeCount") || 1;
const appReplicaCount = config.getNumber("appReplicaCount") || 1;
const region = <digitalocean.Region>config.require("region");

// Create a DigitalOcean Kubernetes cluster.
const cluster = new digitalocean.KubernetesCluster("do-cluster", {
    region,
    version: digitalocean.getKubernetesVersions({versionPrefix: "1.17"}).then(p => p.latestVersion),
    nodePool: {
        name: "default",
        size: digitalocean.DropletSlugs.DropletS2VCPU2GB,
        nodeCount: nodeCount,
    },
});
export const clusterName = cluster.name;

// Based on securing a DOKS tutorial: https://do.co/2XNNDfJ

/** Admin **/

// Create an kubeconfig for admins using a token.
export const kubeconfigAdmin = utils.createTokenKubeconfig(cluster, "admin", adminApiToken);

// Create an admin k8s provider from the admin kubeconfig.
const k8sAdminProvider = new k8s.Provider("k8s-admin", { kubeconfig: kubeconfigAdmin });

// Deploy nginx.
const appLabels = { "app": "app-nginx" };
const app = new k8s.apps.v1.Deployment("do-app-dep", {
    spec: {
        selector: { matchLabels: appLabels },
        replicas: appReplicaCount,
        template: {
            metadata: { labels: appLabels },
            spec: {
                containers: [{ name: "nginx", image: "nginx" }],
            },
        },
    },
}, {provider: k8sAdminProvider});

// Create a public load balanced Service listening for traffic on port 80.
const appService = new k8s.core.v1.Service("do-app-svc", {
    spec: {
        type: "LoadBalancer",
        selector: app.spec.template.metadata.labels,
        ports: [{ port: 80 }],
    },
}, { provider: k8sAdminProvider });
export const ingressIp = appService.status.loadBalancer.ingress[0].ip;
export const ingressUrl = pulumi.interpolate`http://${appService.status.loadBalancer.ingress[0].ip}`;
