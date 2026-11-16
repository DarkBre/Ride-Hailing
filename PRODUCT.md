# Product Truth: DS03 Ride-Hailing Operations & Simulation Console

## Identity & Purpose
- **Product Name:** DS03 Ride-Hailing Operations & Simulation Console
- **System:** Enterprise Distributed Ride-Hailing Microservices Architecture
- **Primary Audience:** Dispatch operators, evaluators, and engineers observing multi-service distributed transactions.
- **Platform:** Web (Interactive Desktop Command Center)
- **Mode:** Operate (High scanability, rapid task execution, precise telemetry, low-distraction dark theme)

## Core Workflows
1. **Persona Authentication & Selection:** Switch between simulated passenger accounts (Standard with balance, Concurrency test candidate, Zero-balance for compensation testing) and driver accounts.
2. **Interactive Dispatch & Booking:** Set pickup and dropoff points via address input or map clicks, compute real-time dynamic pricing, and dispatch rides.
3. **Driver Lifecycle Control:** Toggle driver online/offline availability, simulate GPS movement, and execute ride phases (Accept, Start, Complete, Cancel).
4. **Distributed Saga Observability:** Monitor multi-service 2-phase transactions across Trip, Driver, Matching, Payment, and Notification microservices in real time.
5. **Real-time Event Tracing:** Filter and inspect SSE event stream with Correlation-IDs across RabbitMQ topic exchanges.

## Durable Constraints
- All backend integrations run via API Gateway (`http://localhost:8080/api/v1`) and Server-Sent Events (`/simulation/stream`).
- Preserves all DOM IDs and event bindings required by `app.js`.
- High-contrast, accessibility-compliant typography, no decorative glow slop, no nested container slop, honest live status indicators.
