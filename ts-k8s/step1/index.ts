import * as digitalocean from "@pulumi/digitalocean";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as utils from "./utils";
import * as app from "./app";

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

/** Devs **/
const devsName = "devs";
const csrFp = config.get("csrFilepath") || `${process.cwd()}/certs/devs.csr`;
const keyFp = config.get("keyFilepath") || `${process.cwd()}/certs/devs.key`;
const certFp = config.get("certFilepath") || `${process.cwd()}/certs/devs.cert`;

// Create client certs for devs to use to access the cluster.
const devsCertFilepath = utils.createClientCert("devs", {
    csrFilepath: csrFp,
    certFilepath: certFp,
    kubeconfig: kubeconfigAdmin,
});

// Create a kubeconfig for devs using the client certs.
export const kubeconfigDevs = pulumi.output(devsCertFilepath).apply(cFp => {
    return utils.createCertKubeconfig(cluster, devsName, cFp, keyFp)
});

// Create a devs k8s provider from the devs kubeconfig.
const k8sDevProvider = new k8s.Provider("devs-k8s-provider", { kubeconfig: kubeconfigDevs });

/** Namespace & RBAC **/

// Create an apps namespace for the devs to use.
const appsNamespace = new k8s.core.v1.Namespace("apps", undefined, { provider: k8sAdminProvider });
export const appsNamespaceName = appsNamespace.metadata.name;

// Create a limited k8s role for devs to use in specified namespaces.
const devsRole = utils.createUserNsRole("devs", {
    user: devsName,
    namespace: appsNamespaceName,
    provider: k8sAdminProvider,
});

/** Quota & LimitRanges **/

// Create a k8s resource quota in the apps namespace to restrict compute and API resources.
const quotaAppNs = new k8s.core.v1.ResourceQuota("quota", {
    metadata: {namespace: appsNamespaceName},
    spec: {
        hard: {
            "pods": "10",
            "requests.cpu": "500m",
            "requests.memory": "1Gi",
            "limits.cpu": "1000m",
            "limits.memory": "2Gi",
            "configmaps": "5",
            "persistentvolumeclaims": "5",
            "replicationcontrollers": "10",
            "secrets": "10",
            "services": "5",
            "services.loadbalancers": "5",
        },
    }
},{provider: k8sAdminProvider});

// Create a k8s limit range in the apps namespace to restrict container resource usage.
const limitRangeAppNs = new k8s.core.v1.LimitRange("limit-range", {
    metadata: {namespace: appsNamespaceName},
    spec: {
        limits: [{
            max: {cpu: "400m", memory: "1Gi"},
            min: {cpu: "100m", memory: "100Mi"},
            default: {cpu: "100m", memory: "100Mi"},
            defaultRequest: {cpu: "100m", memory: "100Mi"},
            type: "Container",
        }],
    }
},{provider: k8sAdminProvider});

// Deploy the app as a developer.
const instance = new app.DemoApp("demo", {
    namespace: appsNamespaceName,
    provider: k8sDevProvider,
}, {dependsOn: [devsRole.roleBinding, quotaAppNs, limitRangeAppNs]});

export const instanceUrl = instance.url;
