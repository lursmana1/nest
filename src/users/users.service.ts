import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { BCRYPT_SALT_ROUNDS } from '../common/constants/auth.constants';

/** User as exposed over HTTP — never includes `password` or `googleId`. */
export type PublicUser = Omit<User, 'password' | 'googleId'>;

function toPublicUser(user: User): PublicUser {
  const { password: _password, googleId: _googleId, ...rest } = user;
  return rest;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<PublicUser> {
    const { confirmPassword: _confirmPassword, ...data } = createUserDto;
    const user = this.usersRepository.create({
      ...data,
      password: await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS),
    });
    return toPublicUser(await this.usersRepository.save(user));
  }

  async findAll(): Promise<PublicUser[]> {
    const users = await this.usersRepository.find();
    return users.map(toPublicUser);
  }

  async findOne(id: number): Promise<PublicUser> {
    return toPublicUser(await this.findEntity(id));
  }

  async update(id: number, updateUserDto: UpdateUserDto): Promise<PublicUser> {
    const { confirmPassword: _confirmPassword, ...data } = updateUserDto;
    const user = await this.findEntity(id);
    Object.assign(user, data);
    if (data.password) {
      user.password = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
    }
    return toPublicUser(await this.usersRepository.save(user));
  }

  async remove(id: number): Promise<void> {
    const user = await this.findEntity(id);
    await this.usersRepository.remove(user);
  }

  private async findEntity(id: number): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }
}
