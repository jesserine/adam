using Shop.Core.Services;

// Declared in an implicitly imported namespace so callers need no using.
namespace Microsoft.Extensions.DependencyInjection;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddShopCore(this IServiceCollection services)
    {
        return services.AddScoped<IUserService, UserService>();
    }
}
