{{/*
Expand the name of the chart.
*/}}
{{- define "posthorn.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name. Truncated at 63 chars for the DNS label limit.
*/}}
{{- define "posthorn.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version, as used by the helm.sh/chart label.
*/}}
{{- define "posthorn.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels — the immutable subset matched by the Deployment/Service.
*/}}
{{- define "posthorn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "posthorn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Common labels stamped on every object.
*/}}
{{- define "posthorn.labels" -}}
helm.sh/chart: {{ include "posthorn.chart" . }}
{{ include "posthorn.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: posthorn
{{- end }}

{{/*
ServiceAccount name to use.
*/}}
{{- define "posthorn.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "posthorn.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The resolved container image reference (tag defaults to the chart appVersion).
*/}}
{{- define "posthorn.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end }}

{{/*
Name of the chart-managed Secret (admin token / db url / stripe / signup).
*/}}
{{- define "posthorn.secretName" -}}
{{- printf "%s" (include "posthorn.fullname" .) -}}
{{- end }}

{{/*
Does the chart need to create its own Secret? True when any sensitive value is
provided inline (i.e. not delegated to a user-managed existingSecret).
*/}}
{{- define "posthorn.createsSecret" -}}
{{- $create := false -}}
{{- if and .Values.admin.enabled (not .Values.admin.existingSecret) .Values.admin.token -}}{{- $create = true -}}{{- end -}}
{{- if and (eq .Values.backend.type "postgres") (not .Values.backend.postgres.existingSecret) .Values.backend.postgres.url -}}{{- $create = true -}}{{- end -}}
{{- if and (eq .Values.billing.provider "stripe") (not .Values.billing.stripe.existingSecret) (or .Values.billing.stripe.secretKey .Values.billing.stripe.webhookSecret) -}}{{- $create = true -}}{{- end -}}
{{- $create -}}
{{- end }}

{{/*
Fail fast on incoherent value combinations. Invoked from the Deployment so a
bad `helm install`/`helm template` aborts with a clear, actionable message
instead of producing a manifest that boots into a config error.
*/}}
{{- define "posthorn.validateConfig" -}}
{{- if not (has .Values.backend.type (list "sqlite" "postgres")) -}}
{{- fail (printf "backend.type must be \"sqlite\" or \"postgres\", got %q" .Values.backend.type) -}}
{{- end -}}
{{- if eq .Values.backend.type "sqlite" -}}
{{- if .Values.autoscaling.enabled -}}
{{- fail "backend.type=sqlite is single-writer and cannot autoscale: set autoscaling.enabled=false, or switch to backend.type=postgres to scale out" -}}
{{- end -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- fail (printf "backend.type=sqlite is single-writer: replicaCount must be 1 (got %d), or switch to backend.type=postgres to scale out" (int .Values.replicaCount)) -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.backend.type "postgres" -}}
{{- if and (not .Values.backend.postgres.url) (not .Values.backend.postgres.existingSecret) -}}
{{- fail "backend.type=postgres requires either backend.postgres.url or backend.postgres.existingSecret" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.admin.enabled (not .Values.admin.existingSecret) (not .Values.admin.token) -}}
{{- fail "admin.enabled=true requires admin.token (min 16 chars) or admin.existingSecret" -}}
{{- end -}}
{{- if and (eq .Values.billing.provider "stripe") (not .Values.billing.stripe.existingSecret) (not .Values.billing.stripe.secretKey) -}}
{{- fail "billing.provider=stripe requires billing.stripe.secretKey or billing.stripe.existingSecret" -}}
{{- end -}}
{{- if not (has .Values.billing.provider (list "none" "stripe")) -}}
{{- fail (printf "billing.provider must be \"none\" or \"stripe\", got %q" .Values.billing.provider) -}}
{{- end -}}
{{- end }}

{{/*
Resolved terminationGracePeriodSeconds: the explicit value if set, else derived
from the shutdown drain window (shutdownGraceMs/1000 + 5s headroom).
*/}}
{{- define "posthorn.terminationGracePeriodSeconds" -}}
{{- if .Values.terminationGracePeriodSeconds -}}
{{- .Values.terminationGracePeriodSeconds -}}
{{- else -}}
{{- add (div (int .Values.config.http.shutdownGraceMs) 1000) 5 -}}
{{- end -}}
{{- end }}
