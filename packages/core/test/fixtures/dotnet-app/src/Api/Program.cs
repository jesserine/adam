using Shop.Core.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IUserService, UserService>();
builder.Services.AddShopCore();
var jwtKey = builder.Configuration["Jwt:Key"];
var app = builder.Build();
app.MapControllers();
app.Run();
