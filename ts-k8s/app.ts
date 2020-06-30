import * as k8s from "@pulumi/kubernetes";
import * as kx from "@pulumi/kubernetesx";
import * as digitalocean from "@pulumi/digitalocean";
import * as docker from "@pulumi/docker";
import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export interface DemoAppArgs {
    namespace: pulumi.Input<string>,
    provider: k8s.Provider,
}

export class DemoApp extends pulumi.ComponentResource {
    public readonly imageName: pulumi.Output<string>;
    public readonly configMap: kx.ConfigMap;
    public readonly secret: kx.Secret;
    public readonly deployment: kx.Deployment;
    public readonly service: kx.Service;
    public readonly endpoint: pulumi.Output<string>;
    public readonly url: pulumi.Output<string>;
    constructor(name: string,
        args: DemoAppArgs,
        opts: pulumi.ComponentResourceOptions) {
        super("demo-app", name, args, opts);

        // Create a new container registry repository.
        const registry = new digitalocean.ContainerRegistry(name, {}, {dependsOn: opts.dependsOn});

        // Build a Docker image from a local Dockerfile context in the
        // './node-app' directory, and push it to the registry.
        const appName = "node-app";
        const appDockerContextPath = `./${appName}`;
        const appImage = new docker.Image(appName, {
            imageName: pulumi.interpolate`${registry.endpoint}/${appName}:v0.0.1`,
            build: {context: appDockerContextPath},
        }, {dependsOn: opts.dependsOn});
        this.imageName = appImage.imageName;

        // Create a ConfigMap.
        this.configMap = new kx.ConfigMap("cm", {
            metadata: {namespace: args.namespace},
            data: { "config": "very important data" }
        }, {provider: args.provider, dependsOn: opts.dependsOn});

        // Create a Secret.
        this.secret = new kx.Secret("secret", {
            metadata: {namespace: args.namespace},
            stringData: {
                "password": new random.RandomPassword("pw", {
                    length: 12,
                }, {dependsOn: opts.dependsOn}).result,
            }
        }, {provider: args.provider, dependsOn: opts.dependsOn});

        // Use the local Docker creds to access the container registry.
        const homedir = require('os').homedir();
        const imagePullSecretData = fs.readFileSync(`${homedir}/.docker/config.json`);
        const imagePullSecretStr = imagePullSecretData.toString()
        const imagePullSecretB64 = Buffer.from(imagePullSecretStr).toString("base64");

        // Create an image pull Secret for the Docker creds.
        const imagePullSecret = new kx.Secret("pulumi-image-pull-secret", {
            type: "kubernetes.io/dockerconfigjson",
            metadata: {namespace: args.namespace},
            data: { ".dockerconfigjson": imagePullSecretB64 },
        }, {provider: args.provider, dependsOn: opts.dependsOn});

        // Define the PodBuilder for the Deployment.
        const pb = new kx.PodBuilder({
            imagePullSecrets: [{ name: imagePullSecret.metadata.name }],
            containers: [{
                env: {
                    DATA: this.configMap.asEnvValue("config"),
                    PASSWORD: this.secret.asEnvValue("password"),
                },
                image: this.imageName,
                imagePullPolicy: "Always",
                resources: {requests: {cpu: "100m", memory: "100Mi"}},
                ports: { "http": 80 },
            }],
        });

        // Create a Deployment.
        this.deployment = new kx.Deployment("app-kx", {
            metadata: {namespace: args.namespace},
            spec: pb.asDeploymentSpec(
                {replicas: 2},
            ),
        }, {provider: args.provider, dependsOn: opts.dependsOn});

        // Create a Service.
        this.service = this.deployment.createService({
            type: kx.types.ServiceType.LoadBalancer
        });
        this.url = pulumi.interpolate`http://${this.service.endpoint}`;
    }
}
