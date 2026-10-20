using Microsoft.AspNetCore.Mvc;
using Shop.Core.Models;
using Svc = Shop.Core.Services;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    private readonly Svc.IUserService _service;
    private readonly IConfiguration _configuration;

    public UsersController(Svc.IUserService service, IConfiguration configuration)
    {
        _service = service;
        _configuration = configuration;
    }

    [HttpGet("{id}")]
    public ActionResult<User> Get(int id)
    {
        var region = Environment.GetEnvironmentVariable("SHOP_REGION");
        var db = _configuration.GetConnectionString("Default");
        return _service.Find(id) is { } user ? user : NotFound();
    }
}
