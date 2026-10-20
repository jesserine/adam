namespace Shop.Core.Models;

public partial class User
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public Role Role { get; set; }
}

public enum Role { Customer, Admin }
