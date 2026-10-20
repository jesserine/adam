using System.Collections.Generic;

namespace Shop.Core.Services;

/// <summary>Looks users up.</summary>
public class UserService : IUserService
{
    private readonly Dictionary<int, User> _users = new();

    public UserService() { }

    public User? Find(int id)
    {
        return _users.TryGetValue(id, out var user) ? user : null;
    }

    public IEnumerable<Order> OrdersOf(User user) => [];
}
