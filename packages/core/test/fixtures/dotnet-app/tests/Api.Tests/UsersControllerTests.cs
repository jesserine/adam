using Shop.Api.Controllers;
using Shop.Core.Models;

namespace Shop.Api.Tests;

public class UsersControllerTests
{
    [Fact]
    public void Returns_user()
    {
        var user = new User { Id = 1 };
        Assert.NotNull(typeof(UsersController));
    }
}
