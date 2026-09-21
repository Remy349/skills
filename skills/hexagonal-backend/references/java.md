# Java reference

Written for Java 17/21+ and Spring Boot 3 (the most common stack); Quarkus and Micronaut follow the same structure with their own DI annotations. Match the project's Java version: records, sealed types and pattern matching need 17+/21.

## Contents
1. Detection and tooling
2. Naming and style conventions
3. Layout
4. Vertical slice example (PlaceOrder)
5. Spring Boot wiring (composition root)
6. REST adapter and error mapping
7. Persistence adapters
8. Transactions
9. Testing
10. Pitfalls
11. Architecture enforcement

## 1. Detection and tooling

- Build tool: Maven (`pom.xml`) or Gradle (`build.gradle[.kts]`); follow the wrapper (`mvnw`, `gradlew`). Read the Java version from the toolchain/`maven.compiler.release`.
- Formatting/linting: keep what exists. Good defaults: Spotless with google-java-format, Checkstyle, Error Prone or SpotBugs, `-Xlint:all`. Add JaCoCo for coverage and ArchUnit for architecture tests.
- Detect Spring Boot version (`spring-boot-starter-parent` / plugin). Note API differences: `ProblemDetail` needs Spring 6 / Boot 3; `@MockitoBean` replaces `@MockBean` from Boot 3.4.
- Ecosystem: JUnit 5, AssertJ, Mockito, Testcontainers, Awaitility, MockMvc/WebTestClient/REST Assured.

## 2. Naming and style conventions

Follow the **Google Java Style Guide** (or the project's Checkstyle) and the Oracle conventions.

- Packages: all lowercase, no underscores, reverse-domain (`com.acme.shop.orders.domain`). Classes/interfaces/records/enums: `PascalCase`, nouns. Methods and variables: `camelCase`, verbs for methods. Constants (`static final`): `UPPER_SNAKE_CASE`. Type parameters: `T`, `E`, `K`, `V`.
- **No `I` prefix** on interfaces and avoid the `Impl` suffix. Name the port by capability (`OrderRepository`, `PaymentGateway`) and adapters by technology (`JpaOrderRepository`, `StripePaymentGateway`). Use case interfaces read as verbs: `PlaceOrderUseCase`.
- Use **records** for DTOs, commands, results and value objects (`record Money(long amountCents, String currency)`), with compact constructors for validation. Use **sealed interfaces** for closed result/variant types, `switch` pattern matching, `var` where the type is obvious, text blocks for SQL/JSON.
- Immutability: `final` fields, unmodifiable collections (`List.copyOf`), no public setters on domain types.
- `Optional<T>` only as a **return type** for "may be absent" (never as a field or parameter, never `Optional.get()` without checking; prefer `orElseThrow`). Never return `null` collections; return empty ones.
- Time: `java.time` (`Instant`, `OffsetDateTime`) with an injected `Clock`; money: `BigDecimal` or long minor units; never `double`.
- Exceptions: unchecked exceptions for domain/application errors; checked exceptions only when the caller can realistically recover. Never swallow exceptions; never `catch (Exception e)` without a reason; chain the cause.
- Use `equals`/`hashCode` consistently (entities by id, value objects by value; records give this for free). Prefer constructor injection; never field `@Autowired`.
- Lombok: avoid in the domain (records and explicit code are clearer); if the project uses it, limit to adapters and DTOs.
- Javadoc on public APIs and non-obvious contracts; SLF4J for logging with parameterized messages (`log.info("Order {} placed", id)`).

## 3. Layout

Package-by-feature, then by hexagonal role (single module). For strong compile-time enforcement, split into Maven/Gradle modules (`domain`, `application`, `adapter-web`, `adapter-persistence`, `bootstrap`) so the build file makes forbidden dependencies impossible.

```
com.acme.shop.orders
├── domain/
│   ├── Order.java
│   ├── InvalidOrderException.java
│   └── OrderNotFoundException.java
├── application/
│   ├── port/in/PlaceOrderUseCase.java        # inbound port (+ Command/Result records)
│   ├── port/out/OrderRepository.java         # outbound ports
│   ├── port/out/PaymentGateway.java
│   └── PlaceOrderService.java                # implements PlaceOrderUseCase
├── adapter/
│   ├── in/web/
│   │   ├── OrderController.java
│   │   ├── PlaceOrderRequest.java / PlaceOrderResponse.java
│   │   └── ApiExceptionHandler.java
│   └── out/
│       ├── persistence/ OrderJpaEntity.java, SpringDataOrderRepository.java,
│       │                JpaOrderRepository.java (implements OrderRepository), OrderMapper.java
│       └── payment/StripePaymentGateway.java
└── config/OrdersConfiguration.java           # composition root for this feature
```

## 4. Vertical slice example (PlaceOrder)

```java
// domain/Order.java  (no framework imports)
public final class Order {
    private final String id;
    private final long amountCents;
    private final Status status;
    private final String authorizationId;

    public enum Status { PENDING, AUTHORIZED }

    private Order(String id, long amountCents, Status status, String authorizationId) {
        this.id = id;
        this.amountCents = amountCents;
        this.status = status;
        this.authorizationId = authorizationId;
    }

    public static Order create(String id, long amountCents) {
        if (amountCents <= 0) {
            throw new InvalidOrderException("amountCents must be positive");
        }
        return new Order(id, amountCents, Status.PENDING, null);
    }

    public static Order rehydrate(String id, long amountCents, Status status, String authorizationId) {
        return new Order(id, amountCents, status, authorizationId);
    }

    public Order markAuthorized(String authorizationId) {
        return new Order(id, amountCents, Status.AUTHORIZED, authorizationId);
    }

    public String id() { return id; }
    public long amountCents() { return amountCents; }
    public Status status() { return status; }
    public String authorizationId() { return authorizationId; }
}
```

```java
// domain/InvalidOrderException.java
public class InvalidOrderException extends DomainException {
    public InvalidOrderException(String message) { super("ORDER_INVALID", message); }
}
// DomainException: abstract, extends RuntimeException, carries a stable `code`.
```

```java
// application/port/in/PlaceOrderUseCase.java
public interface PlaceOrderUseCase {
    Result execute(Command command);

    record Command(long amountCents) {}
    record Result(String orderId, String authorizationId) {}
}

// application/port/out/OrderRepository.java
public interface OrderRepository {
    void save(Order order);
    Optional<Order> findById(String id);
}

// application/port/out/PaymentGateway.java
public interface PaymentGateway {
    String authorize(String orderId, long amountCents); // returns authorization id
}
```

```java
// application/PlaceOrderService.java  (plain class: no Spring imports)
public class PlaceOrderService implements PlaceOrderUseCase {
    private final OrderRepository orders;
    private final PaymentGateway payments;
    private final Supplier<String> ids;

    public PlaceOrderService(OrderRepository orders, PaymentGateway payments, Supplier<String> ids) {
        this.orders = orders;
        this.payments = payments;
        this.ids = ids;
    }

    @Override
    public Result execute(Command command) {
        Order order = Order.create(ids.get(), command.amountCents());
        String authorizationId = payments.authorize(order.id(), order.amountCents());
        orders.save(order.markAuthorized(authorizationId));
        return new Result(order.id(), authorizationId);
    }
}
```

## 5. Spring Boot wiring (composition root)

Two acceptable styles; pick one and be consistent:

1. **Pure application layer (preferred for strict boundaries):** the use case has no Spring annotations; a `@Configuration` class creates it as a `@Bean`. Wrap with a transactional decorator (see 8).
2. **Pragmatic:** annotate the application service with `@Service` (and `@Transactional`). It is a small, conscious coupling of the application layer to Spring; the **domain must stay annotation-free** either way.

```java
@Configuration
class OrdersConfiguration {

    @Bean
    PlaceOrderUseCase placeOrderUseCase(OrderRepository orders, PaymentGateway payments,
                                        TransactionTemplate tx) {
        PlaceOrderService core = new PlaceOrderService(orders, payments, () -> UUID.randomUUID().toString());
        return command -> tx.execute(status -> core.execute(command)); // transaction boundary at the use case
    }
}
```

Adapters are Spring components (`@Repository`, `@Component`, `@RestController`) and inject port interfaces through constructors. Bind configuration with `@ConfigurationProperties` records validated with `@Validated`; fail fast at startup.

## 6. REST adapter and error mapping

```java
// adapter/in/web/PlaceOrderRequest.java
public record PlaceOrderRequest(@Positive long amountCents) {}
public record PlaceOrderResponse(String orderId, String authorizationId) {}
```

```java
// adapter/in/web/OrderController.java
@RestController
@RequestMapping("/orders")
class OrderController {
    private final PlaceOrderUseCase placeOrder;

    OrderController(PlaceOrderUseCase placeOrder) { this.placeOrder = placeOrder; }

    @PostMapping
    ResponseEntity<PlaceOrderResponse> place(@Valid @RequestBody PlaceOrderRequest request) {
        var result = placeOrder.execute(new PlaceOrderUseCase.Command(request.amountCents()));
        return ResponseEntity
            .created(URI.create("/orders/" + result.orderId()))
            .body(new PlaceOrderResponse(result.orderId(), result.authorizationId()));
    }
}
```

```java
// adapter/in/web/ApiExceptionHandler.java  (central mapping to RFC 9457 Problem Details)
@RestControllerAdvice
class ApiExceptionHandler extends ResponseEntityExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(InvalidOrderException.class)
    ProblemDetail handle(InvalidOrderException ex) {
        var problem = ProblemDetail.forStatusAndDetail(HttpStatus.UNPROCESSABLE_ENTITY, ex.getMessage());
        problem.setTitle("Business rule violated");
        problem.setProperty("code", ex.code());
        return problem;
    }

    @ExceptionHandler(Exception.class)
    ProblemDetail unexpected(Exception ex) {
        log.error("Unhandled error", ex); // log once, here
        return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "Internal server error");
    }
}
```

`ResponseEntityExceptionHandler` already turns `MethodArgumentNotValidException` and other Spring MVC errors into `ProblemDetail`; override `handleMethodArgumentNotValid` to add field-level `errors`. Enable `spring.mvc.problemdetails.enabled=true` if not extending it. Use `@Valid` with Bean Validation (`jakarta.validation`) on request records only, never on domain types. Document with springdoc-openapi.

## 7. Persistence adapters

- JPA `@Entity` classes are **persistence models** inside `adapter/out/persistence`; map to the domain with a manual mapper or MapStruct. Do not annotate the domain `Order` with `@Entity` (acceptable only as a conscious shortcut for thin CRUD slices).
- Spring Data interfaces (`SpringDataOrderRepository extends JpaRepository<OrderJpaEntity, String>`) are an implementation detail; the port implementation `JpaOrderRepository` wraps them and returns domain objects.
- Set `spring.jpa.open-in-view=false` so lazy loading cannot leak across the boundary. Use projections/DTO queries for read models; watch for N+1 selects (`@EntityGraph`, fetch joins).
- Map `DataIntegrityViolationException` to an application `ConflictException` inside the adapter. Migrations with Flyway or Liquibase, applied in integration tests.

## 8. Transactions

- The boundary is the use case. Options: (a) `@Transactional` on the application service (pragmatic; annotation in the application layer), (b) a `TransactionTemplate` decorator in the configuration class as in section 5 (keeps the service plain), (c) an explicit `UnitOfWork` port.
- Never call remote services inside a transaction and assume atomicity; use the outbox pattern for events.
- `@Transactional` works only through the Spring proxy: a call from another method inside the same class bypasses it. Only unchecked exceptions roll back by default.

## 9. Testing

- **Domain and use case**: plain JUnit 5 + AssertJ, no Spring context. In-memory fakes (`InMemoryOrderRepository implements OrderRepository`). Use `@ParameterizedTest` for tables. Name tests by behavior (`rejectsNonPositiveAmount`, or `@DisplayName`).
- **Controller**: `@WebMvcTest(OrderController.class)` with a fake/mocked use case bean (`@MockitoBean`, or `@MockBean` before Boot 3.4) and `MockMvc`; assert status, `Location`, and Problem Details body.
- **Persistence adapter**: `@DataJpaTest` or a full context with Testcontainers PostgreSQL (`@ServiceConnection` from Boot 3.1+) and the real Flyway migrations; run the shared repository **contract test** against `JpaOrderRepository` and the in-memory fake.
- **HTTP clients** (payment gateway): WireMock or MockWebServer for success/4xx/5xx/timeouts.
- **End to end**: `@SpringBootTest(webEnvironment = RANDOM_PORT)` with `TestRestTemplate`/REST Assured plus containers, for a few journeys.
- Prefer fakes; use Mockito only for interaction checks and for types you own. Do not mock the domain. Inject `Clock` for time (`Clock.fixed(...)`).
- Mutation testing with PIT for critical rules; JaCoCo for coverage trends.

## 10. Pitfalls

- Field injection, service locators, and `ApplicationContext.getBean` in business code.
- Returning JPA entities from controllers (lazy-loading exceptions, accidental exposure, coupling the API to the schema).
- `@Transactional` on controllers or on private/self-invoked methods; long transactions spanning remote calls.
- Anemic domain plus `*ServiceImpl` classes for every interface with a single implementation and no boundary reason.
- `Optional` misuse (fields, parameters, `.get()`), returning `null`, catching `Exception` to hide errors.
- Using `double` for money; `Date`/`Calendar` instead of `java.time`; static utility classes with hidden state.
- Circular dependencies between packages; component scanning that accidentally wires adapters into the domain.

## 11. Architecture enforcement

ArchUnit test (runs with the unit suite):

```java
@AnalyzeClasses(packages = "com.acme.shop", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule domain_is_pure =
        noClasses().that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAnyPackage(
                "..application..", "..adapter..", "..config..",
                "org.springframework..", "jakarta.persistence..", "com.fasterxml.jackson..");

    @ArchTest
    static final ArchRule application_does_not_know_adapters =
        noClasses().that().resideInAPackage("..application..")
            .should().dependOnClassesThat().resideInAnyPackage("..adapter..", "org.springframework.web..");

    @ArchTest
    static final ArchRule inbound_and_outbound_adapters_are_independent =
        noClasses().that().resideInAPackage("..adapter.in..")
            .should().dependOnClassesThat().resideInAPackage("..adapter.out..");
}
```

If the application layer intentionally uses `@Service`/`@Transactional`, allow only `org.springframework.stereotype..` and `org.springframework.transaction..` there and document the exception.
