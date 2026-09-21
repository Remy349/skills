# C# / .NET reference

Written for modern .NET (8 LTS or later) with ASP.NET Core. Detect the `TargetFramework` in the `.csproj` and do not use features newer than the project's C# version (primary constructors need C# 12, `TimeProvider` needs .NET 8).

## Contents
1. Detection and tooling
2. Naming and style conventions
3. Solution layout
4. Vertical slice example (PlaceOrder)
5. ASP.NET Core endpoint, validation and error mapping
6. Composition root
7. Persistence adapters (EF Core)
8. Outbound HTTP adapters
9. Testing
10. Pitfalls
11. Architecture enforcement

## 1. Detection and tooling

- Find `*.sln`/`*.slnx`, `*.csproj`, `global.json`, `Directory.Build.props`, `.editorconfig`. Confirm `<Nullable>enable</Nullable>` and `<ImplicitUsings>`; enable `<TreatWarningsAsErrors>` and analyzers (`Microsoft.CodeAnalysis.NetAnalyzers`, optionally StyleCop/Roslynator) if the team does.
- Formatting: `dotnet format` driven by `.editorconfig`. CLI: `dotnet build`, `dotnet test`.
- API style: Minimal APIs or Controllers (`[ApiController]`); keep the project's choice. Both are inbound adapters.
- Tests: xUnit (most common), NUnit or MSTest. Check assertion/mocking libraries in use before adding new ones and verify their licenses (some popular libraries changed license terms in recent major versions).

## 2. Naming and style conventions

Follow the **Microsoft C# coding conventions and .NET naming guidelines**.

- `PascalCase`: namespaces, types (classes, records, structs, enums, delegates), interfaces, methods, properties, events, public/internal fields, constants. `camelCase`: parameters and locals. **`_camelCase`**: private instance fields (or use primary-constructor parameters).
- **Interfaces start with `I`** (`IOrderRepository`, `IPaymentGateway`) — the .NET convention (unlike TypeScript/Java/Go). Adapters are named by technology (`EfOrderRepository`, `StripePaymentGateway`). Type parameters `TEntity`. Async methods end with `Async` and return `Task`/`ValueTask`; accept a `CancellationToken` as the last parameter and pass it down.
- Namespaces mirror folders; use **file-scoped namespaces** (`namespace Shop.Domain.Orders;`). One top-level type per file; file name equals type name.
- Prefer **records** for DTOs and value objects (`public sealed record Money(long AmountCents, string Currency)`), `init`/`required` properties, `readonly` structs for small value types, primary constructors for DI in classes (C# 12), collection expressions (`[]`), pattern matching, `switch` expressions.
- Mark classes `sealed` unless designed for inheritance. Keep members `private`/`internal` by default. Use `var` when the type is obvious. Prefer expression-bodied members for one-liners only.
- Nullable reference types on: never suppress with `!` casually; model absence as `T?`. Do not return `null` for collections.
- Time: `TimeProvider` (.NET 8) or an injected `IClock`; use `DateTimeOffset`/UTC. Money: `decimal` or long minor units; never `double`/`float`.
- Exceptions: derive domain exceptions from a base `DomainException`; throw specific types; use `throw;` (not `throw ex;`) to rethrow; guard clauses with `ArgumentNullException.ThrowIfNull`.
- **Async all the way**: no `.Result`/`.Wait()`; no `async void` (except event handlers); `ConfigureAwait(false)` is unnecessary in ASP.NET Core application code.
- Use `ILogger<T>` with structured message templates (`_logger.LogInformation("Order {OrderId} placed", id)`), never string interpolation in log calls.
- XML doc comments (`///`) on public APIs.

## 3. Solution layout

Use **separate projects** so the compiler enforces the dependency rule through project references. Organize folders by feature inside each project.

```
src/
  Shop.Domain/            # no package references beyond BCL
    Orders/Order.cs, InvalidOrderException.cs
  Shop.Application/       # references Domain only
    Orders/PlaceOrder/PlaceOrderHandler.cs, PlaceOrderCommand.cs
    Orders/Ports/IOrderRepository.cs, IPaymentGateway.cs
  Shop.Infrastructure/    # outbound adapters; references Application (+Domain)
    Orders/Persistence/ (EfOrderRepository, OrderConfiguration, ShopDbContext)
    Orders/Payments/StripePaymentGateway.cs
  Shop.Api/               # inbound adapter + composition root; references Application + Infrastructure
    Orders/OrderEndpoints.cs, Contracts/, Errors/
    Program.cs
tests/
  Shop.Domain.Tests/  Shop.Application.Tests/  Shop.Api.Tests/
  Shop.Infrastructure.Tests/  Shop.Architecture.Tests/
```

Allowed references: `Domain ← Application ← Infrastructure`, and `Api → Application, Infrastructure` (the latter only to register services in `Program.cs`). `Domain` and `Application` must never reference `Infrastructure` or `Api`. For small services a single project with folders plus architecture tests is acceptable.

## 4. Vertical slice example (PlaceOrder)

```csharp
// Shop.Domain/Orders/Order.cs
namespace Shop.Domain.Orders;

public abstract class DomainException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed class InvalidOrderException(string message) : DomainException("ORDER_INVALID", message);

public sealed class OrderNotFoundException(Guid id) : DomainException("ORDER_NOT_FOUND", $"Order {id} was not found.");

public enum OrderStatus { Pending, Authorized }

public sealed class Order
{
    private Order(Guid id, long amountCents, OrderStatus status, string? authorizationId)
    {
        Id = id;
        AmountCents = amountCents;
        Status = status;
        AuthorizationId = authorizationId;
    }

    public Guid Id { get; }
    public long AmountCents { get; }
    public OrderStatus Status { get; }
    public string? AuthorizationId { get; }

    public static Order Create(Guid id, long amountCents)
    {
        if (amountCents <= 0)
            throw new InvalidOrderException("AmountCents must be positive.");
        return new Order(id, amountCents, OrderStatus.Pending, null);
    }

    public static Order Rehydrate(Guid id, long amountCents, OrderStatus status, string? authorizationId)
        => new(id, amountCents, status, authorizationId);

    public Order MarkAuthorized(string authorizationId)
        => new(Id, AmountCents, OrderStatus.Authorized, authorizationId);
}
```

```csharp
// Shop.Application/Orders/Ports/*.cs
namespace Shop.Application.Orders.Ports;

public interface IOrderRepository
{
    Task SaveAsync(Order order, CancellationToken ct);
    Task<Order?> FindByIdAsync(Guid id, CancellationToken ct);
}

public interface IPaymentGateway
{
    Task<string> AuthorizeAsync(Guid orderId, long amountCents, CancellationToken ct);
}
```

```csharp
// Shop.Application/Orders/PlaceOrder/PlaceOrderHandler.cs
namespace Shop.Application.Orders.PlaceOrder;

public sealed record PlaceOrderCommand(long AmountCents);
public sealed record PlaceOrderResult(Guid OrderId, string AuthorizationId);

public sealed class PlaceOrderHandler(IOrderRepository orders, IPaymentGateway payments)
{
    public async Task<PlaceOrderResult> HandleAsync(PlaceOrderCommand command, CancellationToken ct)
    {
        var order = Order.Create(Guid.NewGuid(), command.AmountCents);
        var authorizationId = await payments.AuthorizeAsync(order.Id, order.AmountCents, ct);
        await orders.SaveAsync(order.MarkAuthorized(authorizationId), ct);
        return new PlaceOrderResult(order.Id, authorizationId);
    }
}
```

A plain handler class is enough. Introducing MediatR (or similar) is optional, adds indirection and a dependency (check its license terms); prefer direct injection of handlers unless you need a pipeline of behaviors across many use cases. If you want an inbound port interface (`IPlaceOrder`) for decorators or multiple adapters, add it.

## 5. ASP.NET Core endpoint, validation and error mapping

```csharp
// Shop.Api/Orders/OrderEndpoints.cs
namespace Shop.Api.Orders;

public sealed record PlaceOrderRequest([property: Range(1, long.MaxValue)] long AmountCents);
public sealed record PlaceOrderResponse(Guid OrderId, string AuthorizationId);

public static class OrderEndpoints
{
    public static IEndpointRouteBuilder MapOrderEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/orders").WithTags("Orders");

        group.MapPost("/", async (PlaceOrderRequest request, PlaceOrderHandler handler, CancellationToken ct) =>
        {
            var result = await handler.HandleAsync(new PlaceOrderCommand(request.AmountCents), ct);
            return Results.Created($"/orders/{result.OrderId}",
                new PlaceOrderResponse(result.OrderId, result.AuthorizationId));
        })
        .Produces<PlaceOrderResponse>(StatusCodes.Status201Created)
        .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        return app;
    }
}
```

Validation of the request shape happens at the edge: DataAnnotations (built-in validation support for Minimal APIs arrived in .NET 10; earlier versions use an endpoint filter or FluentValidation), or `[ApiController]` model validation in Controllers, which returns `ValidationProblemDetails` automatically. Business rules stay in the domain.

Central error mapping with `IExceptionHandler` (.NET 8+) and Problem Details:

```csharp
// Shop.Api/Errors/DomainExceptionHandler.cs
internal sealed class DomainExceptionHandler(IProblemDetailsService problems) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        if (exception is not DomainException domain)
            return false; // let the next handler / default 500 deal with it

        var status = domain switch
        {
            InvalidOrderException => StatusCodes.Status422UnprocessableEntity,
            OrderNotFoundException => StatusCodes.Status404NotFound,
            _ => StatusCodes.Status400BadRequest,
        };
        context.Response.StatusCode = status;
        return await problems.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = status,
                Title = "Business rule violated",
                Detail = domain.Message,
                Extensions = { ["code"] = domain.Code },
            },
        });
    }
}
```

Register `builder.Services.AddProblemDetails(); builder.Services.AddExceptionHandler<DomainExceptionHandler>();` and `app.UseExceptionHandler();`. Unhandled exceptions then produce a generic 500 Problem Details (log them once; never return stack traces outside Development).

## 6. Composition root

`Program.cs` stays short; each project exposes an extension method that registers its own services. Only `Shop.Api` calls them.

```csharp
// Shop.Application/DependencyInjection.cs
public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
        => services.AddScoped<PlaceOrderHandler>();
}

// Shop.Infrastructure/DependencyInjection.cs
public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration config)
    {
        services.AddDbContext<ShopDbContext>(o => o.UseNpgsql(config.GetConnectionString("Shop")));
        services.AddScoped<IOrderRepository, EfOrderRepository>();
        services.AddHttpClient<IPaymentGateway, StripePaymentGateway>(c => c.BaseAddress = new(config["Payments:BaseUrl"]!))
                .AddStandardResilienceHandler();
        services.AddOptions<PaymentsOptions>().Bind(config.GetSection("Payments")).ValidateDataAnnotations().ValidateOnStart();
        return services;
    }
}

// Shop.Api/Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<DomainExceptionHandler>();
builder.Services.AddApplication().AddInfrastructure(builder.Configuration);

var app = builder.Build();
app.UseExceptionHandler();
app.MapOrderEndpoints();
app.Run();

public partial class Program; // makes the entry point visible to WebApplicationFactory<Program>
```

Lifetimes: `DbContext` and handlers are **scoped**; stateless helpers can be singleton; never inject a scoped service into a singleton (captive dependency). Use the options pattern (`IOptions<T>`) with `ValidateOnStart()` for configuration. Graceful shutdown is built into the host (`IHostApplicationLifetime`, `CancellationToken` from requests).

## 7. Persistence adapters (EF Core)

- Configure the mapping with `IEntityTypeConfiguration<Order>` (Fluent API) in `Infrastructure`, so the domain class stays free of attributes. EF Core can populate private constructors and get-only properties; for richer domains use separate persistence models and map explicitly in the repository.
- Repositories return domain objects, never `DbSet` or `IQueryable` (leaky abstraction). Use `AsNoTracking()` for reads, projections (`Select`) for query models, and `ExecuteUpdateAsync`/`ExecuteDeleteAsync` for bulk operations.
- `DbContext.SaveChangesAsync` is the unit of work; if a use case needs one commit across several repositories in the same scope, a shared scoped `DbContext` already provides it. Expose an `IUnitOfWork` port only if the application must control the commit explicitly.
- Translate `DbUpdateException` unique violations into an application `ConflictException` inside the adapter. Migrations via `dotnet ef migrations`, applied in integration tests. Handle optimistic concurrency with a `rowversion`/concurrency token and `DbUpdateConcurrencyException`.

## 8. Outbound HTTP adapters

- Use typed clients via `IHttpClientFactory` (`AddHttpClient<TInterface, TImpl>`), never `new HttpClient()` per call. Set timeouts and add resilience (`AddStandardResilienceHandler()` from `Microsoft.Extensions.Http.Resilience`, or Polly) for retries, circuit breaker and timeout.
- Keep vendor DTOs private to the adapter; map to the port's types. Pass `CancellationToken`. Translate non-success responses into application errors.

## 9. Testing

- **Domain/Application**: xUnit, plain objects, in-memory fakes (`InMemoryOrderRepository : IOrderRepository`). Use `[Theory]` with `[InlineData]`/`[MemberData]` for tables. Test names describe behavior (`PlaceOrder_WhenAmountIsNotPositive_ThrowsInvalidOrder`). Freeze time with `FakeTimeProvider` (`Microsoft.Extensions.TimeProvider.Testing`).
- **API**: `WebApplicationFactory<Program>` with `ConfigureTestServices` to replace ports with fakes; assert status codes, `Location`, and Problem Details bodies with `HttpClient`.
- **Infrastructure**: Testcontainers for .NET (PostgreSQL/SQL Server) + real EF migrations; run the shared repository contract suite against the fake and `EfOrderRepository`. WireMock.Net for outbound HTTP.
- Mocks: NSubstitute or Moq only for interaction checks on ports you own; prefer fakes. Check the license/version policy of the assertion library the team uses.
- Coverage with `coverlet`; mutation with Stryker.NET for critical logic.

## 10. Pitfalls

- Returning EF entities or `IQueryable` from repositories/APIs; lazy loading proxies leaking across layers.
- `async void`, blocking on tasks (`.Result`), forgetting to propagate `CancellationToken`, fire-and-forget without error handling.
- Captive dependencies (singleton holding scoped service); `new`-ing services inside handlers; static service locators (`ServiceProvider.GetService` in business code).
- `catch (Exception)` that swallows; `throw ex;` losing the stack trace; using exceptions for normal control flow in hot paths.
- Primitive obsession with `string`/`Guid` ids and `decimal` without currency; `DateTime.Now` instead of an injected `TimeProvider`.
- Domain project referencing `Microsoft.AspNetCore`, `Microsoft.EntityFrameworkCore` or `System.Text.Json` attributes.
- Bloated `Program.cs`; one giant `Services` folder; MediatR everywhere for a five-endpoint API.

## 11. Architecture enforcement

Project references already forbid `Domain → Infrastructure`. Add NetArchTest (or ArchUnitNET) for the remaining rules and for third-party packages:

```csharp
public class ArchitectureTests
{
    private static readonly Assembly Domain = typeof(Order).Assembly;
    private static readonly Assembly Application = typeof(PlaceOrderHandler).Assembly;

    [Fact]
    public void Domain_has_no_outward_or_framework_dependencies()
    {
        var result = Types.InAssembly(Domain)
            .ShouldNot().HaveDependencyOnAny(
                "Shop.Application", "Shop.Infrastructure", "Shop.Api",
                "Microsoft.AspNetCore", "Microsoft.EntityFrameworkCore", "System.Text.Json")
            .GetResult();

        Assert.True(result.IsSuccessful, string.Join(", ", result.FailingTypeNames ?? []));
    }

    [Fact]
    public void Application_does_not_depend_on_adapters()
    {
        var result = Types.InAssembly(Application)
            .ShouldNot().HaveDependencyOnAny("Shop.Infrastructure", "Shop.Api", "Microsoft.EntityFrameworkCore")
            .GetResult();

        Assert.True(result.IsSuccessful);
    }
}
```

Run them with `dotnet test` in CI together with `dotnet format --verify-no-changes` and the analyzers.
