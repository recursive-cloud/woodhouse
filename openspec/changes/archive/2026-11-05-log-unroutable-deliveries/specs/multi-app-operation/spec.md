# Spec Delta — multi-app-operation

## ADDED Requirements

### Requirement: Unroutable deliveries are logged even when accepted
When a delivery is routed to a served App whose registered handlers cover neither the delivered event nor its event-plus-action, the server SHALL log a warning naming the delivery ID, event, action (when known) and App, and SHALL still respond 200. Handler coverage SHALL never by itself change a response status; a non-2xx response for such a delivery comes only from this capability's other rejection rules (for example an invalid signature), never from the coverage check.

#### Scenario: Event with no registered handler
- **WHEN** a routed App registers listeners only for `pull_request.opened` and a verified `pull_request.edited` delivery arrives
- **THEN** the response is 200 and a warning is logged naming the delivery ID, event, action and App

#### Scenario: Handled event keeps the normal path
- **WHEN** the routed App registers a listener covering the delivered event and action
- **THEN** the delivery follows the normal path and no unroutable warning is logged

#### Scenario: Payload action unknown
- **WHEN** the payload cannot be parsed for an action, or its action is not of the expected shape
- **THEN** the coverage check treats the action as unknown, and if the event is itself unregistered the warning is still logged with the action omitted and the response is still 200

### Requirement: Missing webhook headers are logged on rejection
A delivery missing any required GitHub webhook header (delivery ID, event or signature) SHALL be rejected with 400 AND the rejection SHALL be logged as a warning including the values that were present.

#### Scenario: Missing headers rejected and logged
- **WHEN** a delivery omits one of the required headers
- **THEN** it is rejected with 400 and a warning is logged naming the delivery ID and event where known
